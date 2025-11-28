import OpenAI from "openai";
import { ChromaClient } from "chromadb"
import neo4j from "neo4j-driver";
import dotenv from "dotenv";

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
// 🔌 INICIALIZAR CONEXIONES (ARREGLADO)
// =========================================
async function initConnections() {

  if (neo4jDriver && neo4jSession && chromaClient && chromaCollection) {
    return;
  }

  console.log("🔌 Inicializando conexiones...\n");

  // ===============================
  // NEO4J
  // ===============================
  try {
    neo4jDriver = neo4j.driver(
      NEO4J_URI,
      neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD)
    );

    await neo4jDriver.verifyConnectivity();
    neo4jSession = neo4jDriver.session({ database: NEO4J_DATABASE });

    console.log("✅ Neo4j conectado");
  } catch (err) {
    console.error("❌ Error conectando a Neo4j:", err.message);
    process.exit(1);
  }

  // ===============================
  // CHROMADB + EMBEDDER OPENAI
  // ===============================
  try {
    chromaClient = new ChromaClient({
      path: `http://${CHROMA_HOST}:${CHROMA_PORT}`
    });

    await chromaClient.heartbeat();

    // 👉 Embeddings con OpenAI
    const embedder = async (texts) => {
      const resp = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: texts,
      });
      return resp.data.map(e => e.embedding);
    };

    try {
chromaCollection = await chromaClient.getCollection({
  name: COLLECTION_NAME
});

    } catch {
chromaCollection = await chromaClient.createCollection({
  name: COLLECTION_NAME
});

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
// 🧠 ANALIZAR INTENCIÓN CON OPENAI
// ===============================
async function analizarIntencion(consultaUsuario) {
  const prompt = `Eres un asistente experto en análisis de consultas inmobiliarias sobre INMUEBLES EN VENTA en España.

IMPORTANTE:
- Si el usuario da un precio menor de 10.000 €, IGNÓRALO porque claramente se refiere a alquiler.
- Todos los precios deben interpretarse como precio de VENTA.
- Si no menciona precio, déjalo como null.
- No inventes zonas.

Devuelve SOLO un JSON válido así:

{
  "precio_maximo": number | null,
  "precio_minimo": number | null,
  "habitaciones_minimas": number | null,
  "caracteristicas_obligatorias": array,
  "zonas_preferidas": array,
  "descripcion_semantica": string
}

Consulta del usuario: "${consultaUsuario}"`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 500
    })
    
    const content = response.choices[0].message.content.trim()
    const jsonText = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const intencion = JSON.parse(jsonText)
    
    return intencion
  } catch (error) {
    console.error("❌ Error analizando intención:", error.message)
    return null
  }
}

// ===============================
// 🔍 BÚSQUEDA SEMÁNTICA (CHROMADB)
// ===============================
async function busquedaSemantica(intencion, limite = 20) {
  console.log("\n🔍 Ejecutando búsqueda semántica en ChromaDB...")
  
  try {
    const where = {}
    
    // Construir filtros
    if (intencion.precio_maximo) {
      where.precio = { $lte: intencion.precio_maximo }
    }
    if (intencion.habitaciones_minimas) {
      where.habitaciones = { $gte: intencion.habitaciones_minimas }
    }
    
    const queryText = intencion.descripcion_semantica || "vivienda en alquiler"
    
   const embedding = await openai.embeddings.create({
  model: "text-embedding-3-small",
  input: queryText
});

const results = await chromaCollection.query({
  queryEmbeddings: [embedding.data[0].embedding],
  nResults: limite
});

    
    // Convertir a formato unificado
    const propiedades = []
    for (let i = 0; i < results.ids[0].length; i++) {
      propiedades.push({
        id: results.ids[0][i],
        similarity: (1 - results.distances[0][i]) * 100,
        metadata: results.metadatas[0][i]
      })
    }
    
    console.log(`✅ Encontrados ${propiedades.length} resultados semánticos`)
    return propiedades
    
  } catch (error) {
    console.error("❌ Error en búsqueda semántica:", error.message)
    return []
  }
}

// ===============================
// 🎯 FILTRADO ESTRUCTURADO (NEO4J)
// ===============================
async function filtradoEstructurado(intencion, idsSemanticos = null) {
  console.log("\n🎯 Ejecutando filtrado estructurado en Neo4j...");

  try {
    let query = `MATCH (i:Inmueble)`;
    const params = {};
    const conditions = [];
    

    // -------------------------------
    // 🔎 Filtro por IDs (búsqueda semántica)
    // -------------------------------
    if (idsSemanticos && idsSemanticos.length > 0) {
      conditions.push(`i.id IN $ids`);
      params.ids = idsSemanticos;
    }

    // -------------------------------
    // 💰 Filtros de precio
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
    // 🛏️ Habitaciónes mín/max
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
    // 📏 Metros mínimos
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
    // 🔋 Certificado energético
    // -------------------------------
    if (intencion.certificado_energetico && intencion.certificado_energetico.length > 0) {
      conditions.push(`i.certificado_energetico IN $certificados`);
      params.certificados = intencion.certificado_energetico;
    }

    // -------------------------------
    // 🟩 Aplicar todas las conditions
    // -------------------------------
    if (conditions.length > 0) {
      query += ` WHERE ` + conditions.join(" AND ");
    }

    // -------------------------------
    // 🟦 Características obligatorias
    // -------------------------------
    if (intencion.caracteristicas_obligatorias?.length > 0) {
      for (const carac of intencion.caracteristicas_obligatorias) {
        query += ` AND EXISTS { MATCH (i)-[:TIENE]->(:Caracteristica {nombre: '${carac}'}) }`;
      }
    }

    // -------------------------------
    // 🟧 Zonas preferidas — versión correcta
    // -------------------------------
   if (intencion.zonas_preferidas && intencion.zonas_preferidas.length > 0) {

  params.zonas = intencion.zonas_preferidas.map(z => z.toLowerCase());

  const zonaCondition = `
    EXISTS {
      MATCH (i)-[:UBICADO_EN]->(z:Zona)
      WHERE ANY(zp IN $zonas 
                WHERE toLower(z.nombre) CONTAINS zp
                   OR toLower(z.nombre) = zp)
    }
  `;

  if (!query.includes("WHERE")) {
    query += ` WHERE ${zonaCondition}`;
  } else {
    query += ` AND ${zonaCondition}`;
  }
}

    // -------------------------------
    // 📤 Resultado final
    // -------------------------------
    query += `
      OPTIONAL MATCH (i)-[:UBICADO_EN]->(z:Zona)
      OPTIONAL MATCH (i)-[:TIENE]->(c:Caracteristica)
      RETURN i.id AS id,
             i.precio AS precio,
             i.habitaciones AS habitaciones,
             i.metros AS metros,
             i.tipo_vivienda AS tipo_vivienda,
             i.url AS url,
             z.nombre AS zona,
             collect(DISTINCT c.nombre) AS caracteristicas
      ORDER BY i.precio ASC
      LIMIT 50
    `;

    const result = await neo4jSession.run(query, params);

const propiedades = result.records.map(record => {
  const precioValue = record.get("precio");
  const habValue = record.get("habitaciones");
  const metrosValue = record.get("metros");

  return {
    id: record.get("id"),
    precio: typeof precioValue?.toNumber === "function"
      ? precioValue.toNumber()
      : precioValue ?? null,

    habitaciones: typeof habValue?.toNumber === "function"
      ? habValue.toNumber()
      : habValue ?? null,

    metros: typeof metrosValue?.toNumber === "function"
      ? metrosValue.toNumber()
      : metrosValue ?? null,

    tipo_vivienda: record.get("tipo_vivienda"),
    zona: record.get("zona"),
    url: record.get("url"),
    caracteristicas: record.get("caracteristicas")
  };
});

    console.log(`✅ Encontrados ${propiedades.length} resultados estructurados`);
    return propiedades;

  } catch (error) {
    console.error("❌ Error en filtrado Neo4j:", error.message);
    return [];
  }
}
// ===============================
// 🔀 FUSIÓN HÍBRIDA
// ===============================
function fusionarResultados(resultadosSemanticos, resultadosEstructurados, intencion) {
  console.log("\n🔀 Fusionando resultados...")
  
  // Crear mapa de resultados semánticos por ID
  const mapaSematico = {}
  resultadosSemanticos.forEach(r => {
    mapaSematico[r.id] = r.similarity
  })
  
  // Puntuar resultados estructurados
  const resultadosFusion = resultadosEstructurados.map(inmueble => {
    let score = 0
    
    // Score por similitud semántica (si está en resultados semánticos)
    if (mapaSematico[inmueble.id]) {
      score += mapaSematico[inmueble.id] * 0.6 // 60% peso semántico
    }
    
    // Score por características obligatorias cumplidas
    if (intencion.caracteristicas_obligatorias) {
      const caracsCumplidas = intencion.caracteristicas_obligatorias.filter(
        c => inmueble.caracteristicas.includes(c)
      ).length
      score += (caracsCumplidas / intencion.caracteristicas_obligatorias.length) * 20
    }
    
    // Score por características deseadas
    if (intencion.caracteristicas_deseadas) {
      const caracsDeseadas = intencion.caracteristicas_deseadas.filter(
        c => inmueble.caracteristicas.includes(c)
      ).length
      score += caracsDeseadas * 5
    }
    
    // Penalización por precio alto (si hay límite)
    if (intencion.precio_maximo && inmueble.precio) {
      const ratioPrice = inmueble.precio / intencion.precio_maximo
      score -= ratioPrice * 10
    }
    
    return { ...inmueble, score }
  })
  
  // Ordenar por score
  resultadosFusion.sort((a, b) => b.score - a.score)
  
  console.log(`✅ Fusión completada: ${resultadosFusion.length} resultados rankeados`)
  return resultadosFusion
}

// ===============================
// 🤖 GENERAR RESPUESTA CON OPENAI
// ===============================
async function generarRespuesta(consultaUsuario, intencion, resultados) {
  console.log("\n🤖 Generando respuesta con OpenAI...")
  
  // Preparar resumen de resultados
  const resumenResultados = resultados.slice(0, 10).map((r, idx) => {
    const caracteristicas = r.caracteristicas.slice(0, 5).join(', ')
    return `${idx + 1}. ${r.tipo_vivienda || 'Inmueble'} en ${r.zona || 'zona desconocida'}
   - Precio: ${r.precio}€/mes
   - ${r.habitaciones} habitaciones, ${r.metros}m²
   - Características: ${caracteristicas || 'sin especificar'}
   - Score de relevancia: ${r.score.toFixed(1)}
   - URL: ${r.url || 'No disponible'}`
  }).join('\n\n')
  
  const prompt = `Eres un asistente inmobiliario experto. El usuario preguntó:
"${consultaUsuario}"

Análisis de la consulta:
- Precio máximo: ${intencion.precio_maximo || 'sin límite'}€
- Habitaciones: ${intencion.habitaciones_minimas || 'sin mínimo'}+
- Características obligatorias: ${intencion.caracteristicas_obligatorias?.join(', ') || 'ninguna'}
- Búsqueda semántica: "${intencion.descripcion_semantica}"

Resultados encontrados (${resultados.length} en total, mostrando top 10):

${resumenResultados}

Genera una respuesta natural y útil que:
1. Resuma los mejores resultados encontrados
2. Destaque las opciones más relevantes (2-3 inmuebles)
3. Explique por qué son buenas opciones
4. Ofrezca alternativas si es necesario
5. Sea conversacional y amigable

No inventes datos. Usa solo la información proporcionada.`

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 800
    })
    
    return response.choices[0].message.content
  } catch (error) {
    console.error("❌ Error generando respuesta:", error.message)
    return "Lo siento, no pude generar una respuesta. Aquí están los resultados encontrados."
  }
}

// ===============================
// 🚀 PROCESAR CONSULTA
// ===============================
async function procesarConsulta(consultaUsuario) {
  console.log("\n" + "=".repeat(70))
  console.log(`📝 Consulta: "${consultaUsuario}"`)
  console.log("=".repeat(70))
  
  // 1. Analizar intención
  const intencion = await analizarIntencion(consultaUsuario)
  if (!intencion) {
    console.log("❌ No pude entender tu consulta. Intenta reformularla.")
    return
  }
  
  console.log("\n📊 Intención detectada:")
  console.log(`   • Precio máximo: ${intencion.precio_maximo || 'sin límite'}`)
  console.log(`   • Habitaciones: ${intencion.habitaciones_minimas || 'sin mínimo'}+`)
  console.log(`   • Características: ${intencion.caracteristicas_obligatorias?.join(', ') || 'ninguna'}`)
  console.log(`   • Búsqueda semántica: "${intencion.descripcion_semantica}"`)
  
  // 2. Búsqueda semántica
  const resultadosSemanticos = await busquedaSemantica(intencion)
  
  // 3. Filtrado estructurado (usando IDs semánticos como punto de partida)
  const idsSemanticos = resultadosSemanticos.map(r => r.id)
  const resultadosEstructurados = await filtradoEstructurado(intencion, idsSemanticos)
  
  if (resultadosEstructurados.length === 0) {
    console.log("\n❌ No se encontraron inmuebles que cumplan los criterios.")
    console.log("💡 Intenta ajustar tus filtros (precio, habitaciones, características)")
    return
  }
  
  // 4. Fusión híbrida
  const resultadosFinales = fusionarResultados(resultadosSemanticos, resultadosEstructurados, intencion)
  
  // 5. Generar respuesta
  const respuesta = await generarRespuesta(consultaUsuario, intencion, resultadosFinales)
  
  console.log("\n" + "=".repeat(70))
  console.log("🤖 RESPUESTA DEL ASISTENTE")
  console.log("=".repeat(70))
  console.log(respuesta)
  console.log("\n" + "=".repeat(70))
}


// ===============================
// 🔌 CERRAR CONEXIONES
// ===============================
async function cerrarConexiones() {
  if (neo4jSession) await neo4jSession.close()
  if (neo4jDriver) await neo4jDriver.close()
}

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

  const resultadosSemanticos = await busquedaSemantica(intencion);
  const ids = resultadosSemanticos.map(r => r.id);

  const resultadosEstructurados = await filtradoEstructurado(intencion, ids);

  if (resultadosEstructurados.length === 0) {
    return { resultados: [], mensaje: "No encontré inmuebles con esos criterios." };
  }

  const fusionados = fusionarResultados(resultadosSemanticos, resultadosEstructurados, intencion);
  const explicacion = await generarRespuesta(consultaUsuario, intencion, fusionados);

  return { resultados: fusionados, explicacion };
}

export { buscarInmueblesHibrido };
