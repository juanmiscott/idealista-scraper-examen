import OpenAI from "openai";
import { ChromaClient } from "chromadb"
import neo4j from "neo4j-driver";
import dotenv from "dotenv"

dotenv.config();

// =========================================
// CONFIG
// =========================================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const NEO4J_URI = process.env.NEO4J_URI || "neo4j://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "password";
const NEO4J_DATABASE = "idealista";

const CHROMA_HOST = process.env.CHROMA_HOST || "localhost";
const CHROMA_PORT = process.env.CHROMA_PORT || 8000;
const COLLECTION_NAME = "inmuebles_idealista";

let neo4jDriver = null;
let neo4jSession = null;
let chromaClient = null;
let chromaCollection = null;

// =========================================
// 🔌 INICIALIZAR CONEXIONES
// =========================================
async function initConnections() {
  if (neo4jDriver && neo4jSession && chromaClient && chromaCollection) {
    return;
  }

  console.log("🔌 Inicializando conexiones...\n");

  // Neo4j
  try {
    neo4jDriver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
    await neo4jDriver.verifyConnectivity();
    neo4jSession = neo4jDriver.session({ database: NEO4J_DATABASE });
    console.log("✅ Neo4j conectado");
  } catch (err) {
    console.error("❌ Error conectando a Neo4j:", err.message);
    process.exit(1);
  }

  // ChromaDB
  try {
    chromaClient = new ChromaClient({ path: `http://${CHROMA_HOST}:${CHROMA_PORT}` });
    await chromaClient.heartbeat();

    try {
      chromaCollection = await chromaClient.getCollection({ name: COLLECTION_NAME });
    } catch {
      chromaCollection = await chromaClient.createCollection({ name: COLLECTION_NAME });
    }

    console.log("✅ ChromaDB conectado");
  } catch (err) {
    console.error("❌ Error conectando a ChromaDB:", err.message);
    console.log("💡 Ejecuta: chroma run --path ./chroma_data");
    process.exit(1);
  }

  console.log("✅ Todas las conexiones establecidas\n");
}

// ===============================
// 🧠 ANALIZAR INTENCIÓN MEJORADO
// ===============================
async function analizarIntencion(consultaUsuario) {
  const prompt = `Eres un asistente experto en análisis de consultas inmobiliarias.

IMPORTANTE:
- Extrae SOLO características que existan en esta lista: "ascensor", "terraza", "balcon", "garaje", "parking", "piscina", "aire_acondicionado", "calefaccion", "amueblado", "trastero", "jardin"
- Si mencionan "luminoso", "exterior", "reformado", "planta baja": NO las pongas en caracteristicas_obligatorias, ponlas en descripcion_semantica
- Las zonas deben ser nombres reales de barrios/ciudades en España
- Si no se menciona precio, usa null

Devuelve SOLO un JSON válido:

{
  "precio_maximo": number | null,
  "precio_minimo": number | null,
  "habitaciones_minimas": number | null,
  "habitaciones_maximas": number | null,
  "metros_minimos": number | null,
  "caracteristicas_obligatorias": array (solo características físicas verificables),
  "caracteristicas_deseadas": array,
  "zonas_preferidas": array,
  "tipo_vivienda": string | null,
  "descripcion_semantica": string (incluye aspectos subjetivos como luminoso, reformado, tranquilo, planta baja, exterior)
}

Consulta: "${consultaUsuario}"`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 500
    });
    
    const content = response.choices[0].message.content.trim();
    const jsonText = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const intencion = JSON.parse(jsonText);
    
    return intencion;
  } catch (error) {
    console.error("❌ Error analizando intención:", error.message);
    return null;
  }
}

// ===============================
// 🔍 BÚSQUEDA SEMÁNTICA MEJORADA
// ===============================
async function busquedaSemantica(intencion, limite = 50) {
  console.log("\n🔍 Ejecutando búsqueda semántica en ChromaDB...");
  
  try {
    // IMPORTANTE: NO usar filtros where aquí, dejar que ChromaDB encuentre lo más similar
    // Los filtros se aplicarán después en Neo4j
    
    const queryText = intencion.descripcion_semantica || "vivienda";
    
    const embedding = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: queryText
    });

    const results = await chromaCollection.query({
      queryEmbeddings: [embedding.data[0].embedding],
      nResults: limite, // Aumentado para tener más candidatos
      // NO usar where aquí - deja que la semántica haga su trabajo
    });
    
    // Convertir a formato unificado
    const propiedades = [];
    for (let i = 0; i < results.ids[0].length; i++) {
      propiedades.push({
        id: results.ids[0][i],
        similarity: (1 - results.distances[0][i]) * 100,
        metadata: results.metadatas[0][i]
      });
    }
    
    console.log(`✅ Encontrados ${propiedades.length} candidatos semánticos`);
    return propiedades;
    
  } catch (error) {
    console.error("❌ Error en búsqueda semántica:", error.message);
    return [];
  }
}

// ===============================
// 🎯 FILTRADO ESTRUCTURADO FLEXIBLE
// ===============================
async function filtradoEstructurado(intencion, idsSemanticos = null) {
  console.log("\n🎯 Ejecutando filtrado estructurado en Neo4j...");

  try {
    let query = `MATCH (i:Inmueble)`;
    const params = {};
    const conditions = [];

    // 🔥 CAMBIO CLAVE: Hacer filtro de IDs OPCIONAL, no obligatorio
    if (idsSemanticos && idsSemanticos.length > 0) {
      // Solo sugerir estos IDs, pero no restringir a ellos
      params.ids_sugeridos = idsSemanticos;
    }

    // -------------------------------
    // 💰 Filtros de precio (OBLIGATORIOS si se especifican)
    // -------------------------------
    if (intencion.precio_maximo) {
      conditions.push(`i.precio <= $precio_max`);
      params.precio_max = neo4j.int(intencion.precio_maximo);
    }

    if (intencion.precio_minimo) {
      conditions.push(`i.precio >= $precio_min`);
      params.precio_min = neo4j.int(intencion.precio_minimo);
    }

    // -------------------------------
    // 🛏️ Habitaciones (OBLIGATORIOS si se especifican)
    // -------------------------------
    if (intencion.habitaciones_minimas) {
      conditions.push(`i.habitaciones >= $hab_min`);
      params.hab_min = neo4j.int(intencion.habitaciones_minimas);
    }

    if (intencion.habitaciones_maximas) {
      conditions.push(`i.habitaciones <= $hab_max`);
      params.hab_max = neo4j.int(intencion.habitaciones_maximas);
    }

    // -------------------------------
    // 📏 Metros
    // -------------------------------
    if (intencion.metros_minimos) {
      conditions.push(`i.metros >= $metros_min`);
      params.metros_min = neo4j.int(intencion.metros_minimos);
    }

    // -------------------------------
    // 🏠 Tipo de vivienda
    // -------------------------------
    if (intencion.tipo_vivienda) {
      conditions.push(`toLower(i.tipo_vivienda) = toLower($tipo)`);
      params.tipo = intencion.tipo_vivienda;
    }

    // -------------------------------
    // 🟦 Características SOLO si son verificables
    // -------------------------------
    const caracteristicasValidas = [
      'ascensor', 'terraza', 'balcon', 'garaje', 'parking', 
      'piscina', 'aire_acondicionado', 'calefaccion', 'amueblado',
      'trastero', 'jardin', 'zona_comunitaria', 'cocina_equipada',
      'armarios_empotrados'
    ];

    if (intencion.caracteristicas_obligatorias?.length > 0) {
      for (const carac of intencion.caracteristicas_obligatorias) {
        // Solo aplicar si la característica existe en Neo4j
        if (caracteristicasValidas.includes(carac.toLowerCase())) {
          conditions.push(`
            EXISTS {
              MATCH (i)-[:TIENE]->(:Caracteristica {nombre: '${carac}'})
            }
          `);
        }
      }
    }

    // -------------------------------
    // 🟧 Zonas preferidas
    // -------------------------------
    if (intencion.zonas_preferidas?.length > 0) {
      params.zonas = intencion.zonas_preferidas.map(z => z.toLowerCase());

      conditions.push(`
        EXISTS {
          MATCH (i)-[:UBICADO_EN]->(z:Zona)
          WHERE ANY(zp IN $zonas WHERE 
              toLower(z.nombre) CONTAINS zp 
              OR toLower(z.nombre) = zp)
        }
      `);
    }

    // Aplicar condiciones
    if (conditions.length > 0) {
      query += ` WHERE ` + conditions.join(' AND ');
    }

    // -------------------------------
    // 📤 Resultado final con scoring
    // -------------------------------
    query += `
      OPTIONAL MATCH (i)-[:UBICADO_EN]->(z:Zona)
      OPTIONAL MATCH (i)-[:TIENE]->(c:Caracteristica)
      
      // Calcular score de coincidencia con IDs sugeridos
      WITH i, z, collect(DISTINCT c.nombre) as caracteristicas,
           CASE WHEN $ids_sugeridos IS NOT NULL AND i.id IN $ids_sugeridos 
                THEN 100 
                ELSE 0 
           END as bonus_semantico
      
      RETURN i.id AS id,
             i.precio AS precio,
             i.habitaciones AS habitaciones,
             i.metros AS metros,
             i.tipo_vivienda AS tipo_vivienda,
             i.url AS url,
             i.planta AS planta,
             i.luminosidad AS luminosidad,
             i.exterior_interior AS exterior_interior,
             i.reforma AS reforma,
             z.nombre AS zona,
             caracteristicas,
             bonus_semantico
      ORDER BY bonus_semantico DESC, i.precio ASC
      LIMIT 100
    `;

    params.ids_sugeridos = params.ids_sugeridos || null;

    const result = await neo4jSession.run(query, params);

    const propiedades = result.records.map(record => ({
      id: record.get("id"),
      precio: record.get("precio")?.toNumber?.() ?? record.get("precio"),
      habitaciones: record.get("habitaciones")?.toNumber?.() ?? record.get("habitaciones"),
      metros: record.get("metros")?.toNumber?.() ?? record.get("metros"),
      tipo_vivienda: record.get("tipo_vivienda"),
      planta: record.get("planta"),
      luminosidad: record.get("luminosidad"),
      exterior_interior: record.get("exterior_interior"),
      reforma: record.get("reforma"),
      zona: record.get("zona"),
      url: record.get("url"),
      caracteristicas: record.get("caracteristicas"),
      bonus_semantico: record.get("bonus_semantico")?.toNumber?.() ?? 0
    }));

    console.log(`✅ Encontrados ${propiedades.length} resultados estructurados`);
    return propiedades;

  } catch (error) {
    console.error("❌ Error en filtrado Neo4j:", error.message);
    return [];
  }
}

// ===============================
// 🔀 FUSIÓN HÍBRIDA MEJORADA
// ===============================
function fusionarResultados(resultadosSemanticos, resultadosEstructurados, intencion) {
  console.log("\n🔀 Fusionando resultados...");
  
  // Crear mapa de similitud semántica
  const mapaSematico = {};
  resultadosSemanticos.forEach(r => {
    mapaSematico[r.id] = r.similarity;
  });
  
  // Puntuar resultados
  const resultadosFusion = resultadosEstructurados.map(inmueble => {
    let score = 0;
    
    // 1. Score semántico (40% peso)
    if (mapaSematico[inmueble.id]) {
      score += mapaSematico[inmueble.id] * 0.4;
    } else {
      // Penalización leve si no está en resultados semánticos
      score -= 10;
    }
    
    // 2. Bonus si ya tiene bonus_semantico de Neo4j (20%)
    score += inmueble.bonus_semantico * 0.2;
    
    // 3. Score por características (20%)
    if (intencion.caracteristicas_obligatorias?.length > 0) {
      const caracsCumplidas = intencion.caracteristicas_obligatorias.filter(
        c => inmueble.caracteristicas.includes(c)
      ).length;
      score += (caracsCumplidas / intencion.caracteristicas_obligatorias.length) * 20;
    }
    
    // 4. Bonus por atributos descriptivos en descripcion_semantica (20%)
    if (intencion.descripcion_semantica) {
      const desc = intencion.descripcion_semantica.toLowerCase();
      
      // Luminoso
      if (desc.includes('luminoso') && inmueble.luminosidad?.toLowerCase().includes('luminoso')) {
        score += 15;
      }
      
      // Exterior/Interior
      if (desc.includes('exterior') && inmueble.exterior_interior === 'exterior') {
        score += 15;
      }
      
      // Planta baja
      if (desc.includes('planta baja') && inmueble.planta?.toLowerCase().includes('bajo')) {
        score += 15;
      }
      
      // Reformado
      if (desc.includes('reformado') && inmueble.reforma?.toLowerCase().includes('reformado')) {
        score += 15;
      }
    }
    
    // 5. Penalización por precio (si hay límite)
    if (intencion.precio_maximo && inmueble.precio) {
      const ratioPrice = inmueble.precio / intencion.precio_maximo;
      score -= ratioPrice * 5;
    }
    
    return { ...inmueble, score };
  });
  
  // Ordenar por score
  resultadosFusion.sort((a, b) => b.score - a.score);
  
  console.log(`✅ Fusión completada: ${resultadosFusion.length} resultados rankeados`);
  return resultadosFusion;
}

// ===============================
// 🤖 GENERAR RESPUESTA
// ===============================
async function generarRespuesta(consultaUsuario, intencion, resultados) {
  console.log("\n🤖 Generando respuesta con OpenAI...");
  
  const resumenResultados = resultados.slice(0, 10).map((r, idx) => {
    const caracteristicas = r.caracteristicas.slice(0, 5).join(', ');
    const extras = [];
    if (r.planta) extras.push(`Planta: ${r.planta}`);
    if (r.luminosidad) extras.push(r.luminosidad);
    if (r.exterior_interior) extras.push(r.exterior_interior);
    if (r.reforma) extras.push(r.reforma);
    
    return `${idx + 1}. ${r.tipo_vivienda || 'Inmueble'} en ${r.zona || 'zona desconocida'}
   - Precio: ${r.precio}€/mes
   - ${r.habitaciones} habitaciones, ${r.metros}m²
   - Características: ${caracteristicas || 'sin especificar'}
   ${extras.length > 0 ? `   - Detalles: ${extras.join(', ')}` : ''}
   - Score: ${r.score.toFixed(1)}
   - URL: ${r.url || 'No disponible'}`;
  }).join('\n\n');
  
  const prompt = `Eres un asistente inmobiliario experto. El usuario preguntó:
"${consultaUsuario}"

Análisis:
- Precio máximo: ${intencion.precio_maximo || 'sin límite'}€
- Habitaciones: ${intencion.habitaciones_minimas || 'sin mínimo'}+
- Características: ${intencion.caracteristicas_obligatorias?.join(', ') || 'ninguna'}
- Aspectos semánticos: "${intencion.descripcion_semantica}"

Resultados (${resultados.length} total, top 10):

${resumenResultados}

Genera respuesta natural destacando 2-3 mejores opciones y explicando por qué son buenas.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 800
    });
    
    return response.choices[0].message.content;
  } catch (error) {
    console.error("❌ Error generando respuesta:", error.message);
    return "Resultados encontrados.";
  }
}

// ===============================
// 🔌 CERRAR CONEXIONES
// ===============================
async function cerrarConexiones() {
  if (neo4jSession) await neo4jSession.close();
  if (neo4jDriver) await neo4jDriver.close();
}

// ===============================
// 🚀 FUNCIÓN PRINCIPAL EXPORTADA
// ===============================
async function buscarInmueblesHibrido(consultaUsuario) {
  await initConnections();

  const intencion = await analizarIntencion(consultaUsuario);
  
  console.log("\n📊 Intención detectada:");
  console.log("   • Precio máximo:", intencion.precio_maximo);
  console.log("   • Habitaciones mínimas:", intencion.habitaciones_minimas);
  console.log("   • Características obligatorias:", intencion.caracteristicas_obligatorias);
  console.log("   • Zonas preferidas:", intencion.zonas_preferidas);
  console.log("   • Descripción semántica:", intencion.descripcion_semantica);

  if (!intencion) {
    return { error: true, mensaje: "No pude interpretar la consulta." };
  }

  // 1. Búsqueda semántica (amplia)
  const resultadosSemanticos = await busquedaSemantica(intencion);
  const ids = resultadosSemanticos.map(r => r.id);

  // 2. Filtrado estructurado (flexible)
  const resultadosEstructurados = await filtradoEstructurado(intencion, ids);

  if (resultadosEstructurados.length === 0) {
    return { 
      resultados: [], 
      mensaje: "No encontré inmuebles con esos criterios. Intenta ser menos específico." 
    };
  }

  // 3. Fusión inteligente
  const fusionados = fusionarResultados(resultadosSemanticos, resultadosEstructurados, intencion);
  
  // 4. Explicación
  const explicacion = await generarRespuesta(consultaUsuario, intencion, fusionados);

  return { resultados: fusionados, explicacion };
}

export { buscarInmueblesHibrido, cerrarConexiones };