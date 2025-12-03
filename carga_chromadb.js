import fs from "fs"
import { ChromaClient } from "chromadb"
import OpenAI from "openai"
import dotenv from "dotenv"

dotenv.config()

// ===============================
// 🔧 CONFIGURACIÓN
// ===============================
const INPUT_FILE = "./bbdd/Propiedades_normalizadas.json"
const COLLECTION_NAME = "inmuebles_idealista"
const CHROMA_HOST = process.env.CHROMA_HOST || "localhost"
const CHROMA_PORT = process.env.CHROMA_PORT || 8000

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

// ===============================
// 📄 GENERAR DOCUMENTO SEMÁNTICO
// ===============================
function createSemanticDocument(prop) {
  const parts = []
  
  // 1. Tipo de vivienda y ubicación
  const tipo = prop.atributos?.tipo_vivienda || 'Inmueble'
  const zona = prop.ubicacion?.barrio || prop.ubicacion?.ciudad || 'ubicación no especificada'
  parts.push(`${tipo} en ${zona}`)
  
  // 2. Descripción original (la más rica semánticamente)
  if (prop.descripcion_original) {
    parts.push(prop.descripcion_original)
  }
  
  // 3. Resumen semántico generado por IA (si existe)
  if (prop.atributos?.resumen_semantico) {
    parts.push(prop.atributos.resumen_semantico)
  }
  
  // 4. Características textualizadas de forma natural
  const caracteristicas = []
  const attrs = prop.atributos || {}
  
  // Booleanas
  const boolFeatures = {
    ascensor: 'con ascensor',
    terraza: 'con terraza',
    balcon: 'con balcón',
    garaje: 'con garaje',
    parking: 'con parking',
    trastero: 'con trastero',
    amueblado: 'amueblado',
    aire_acondicionado: 'con aire acondicionado',
    calefaccion: 'con calefacción',
    piscina: 'con piscina',
    jardin: 'con jardín',
    zona_comunitaria: 'con zona comunitaria',
    mascotas: 'admite mascotas',
    cocina_equipada: 'cocina equipada',
    armarios_empotrados: 'armarios empotrados',
    puerta_blindada: 'puerta blindada',
    videoportero: 'videoportero',
    alarma: 'con alarma',
    accesible: 'accesible'
  }
  
  for (const [key, text] of Object.entries(boolFeatures)) {
    if (attrs[key] === true) {
      caracteristicas.push(text)
    }
  }
  
  if (caracteristicas.length > 0) {
    parts.push(`Características: ${caracteristicas.join(', ')}`)
  }
  
  // 5. Atributos descriptivos importantes para búsqueda semántica
  if (attrs.reforma) parts.push(`Estado: ${attrs.reforma}`)
  if (attrs.orientacion) parts.push(`Orientación ${attrs.orientacion}`)
  if (attrs.luminosidad) parts.push(attrs.luminosidad)
  if (attrs.vistas) parts.push(`Con vistas ${attrs.vistas}`)
  if (attrs.exterior_interior) parts.push(attrs.exterior_interior)
  if (attrs.certificado_energetico) parts.push(`Certificado energético ${attrs.certificado_energetico}`)
  if (attrs.calefaccion_tipo) parts.push(`Calefacción ${attrs.calefaccion_tipo}`)
  
  // 6. Servicios cercanos
  if (attrs.servicios_cercanos && attrs.servicios_cercanos.length > 0) {
    parts.push(`Cerca de: ${attrs.servicios_cercanos.join(', ')}`)
  }
  
  // 7. Características destacadas
  if (attrs.caracteristicas_destacadas && attrs.caracteristicas_destacadas.length > 0) {
    parts.push(attrs.caracteristicas_destacadas.join('. '))
  }
  
  // 8. Información numérica contextualizada
  const detalles = []
  if (prop.habitaciones) detalles.push(`${prop.habitaciones} habitaciones`)
  if (prop.metros) detalles.push(`${prop.metros} m²`)
  if (prop.precio) detalles.push(`${prop.precio}€`)
  if (attrs.planta) detalles.push(`planta ${attrs.planta}`)
  
  if (detalles.length > 0) {
    parts.push(detalles.join(', '))
  }
  
  // Unir todo con espacios y limpiar
  return parts.join('. ').replace(/\.\s*\./g, '.').trim()
}

// ===============================
// 🧠 GENERAR EMBEDDING CON OPENAI
// ===============================
async function generarEmbedding(texto) {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texto
  })
  
  return response.data[0].embedding
}

// ===============================
// 🗄️ INICIALIZAR CHROMADB
// ===============================
async function initChromaDB() {
  const url = `http://${CHROMA_HOST}:${CHROMA_PORT}`
  console.log(`🔌 Conectando a ChromaDB en ${url}...`)
  
  try {
    const client = new ChromaClient({ path: url })
    await client.heartbeat()
    console.log("✅ Conexión exitosa a ChromaDB\n")
    return client
  } catch (error) {
    console.error("❌ Error conectando a ChromaDB:", error.message)
    console.log("💡 Ejecuta: chroma run --path ./chroma_data")
    process.exit(1)
  }
}

// ===============================
// 📦 CREAR O RESETEAR COLECCIÓN
// ===============================
async function setupCollection(client, reset = true) {
  console.log(`📦 Configurando colección '${COLLECTION_NAME}'...`)
  
  try {
    if (reset) {
      try {
        await client.deleteCollection({ name: COLLECTION_NAME })
        console.log("🧹 Colección anterior eliminada")
      } catch (error) {
        // No existe, continuamos
      }
    }
    
    // Crear colección SIN embedding function (usaremos embeddings manuales)
    const collection = await client.createCollection({
      name: COLLECTION_NAME,
      metadata: { 
        description: "Inmuebles de Idealista con búsqueda semántica"
      }
    })
    
    console.log("✅ Colección creada exitosamente\n")
    return collection
    
  } catch (error) {
    console.error("❌ Error configurando colección:", error.message)
    process.exit(1)
  }
}

// ===============================
// 📥 CARGAR DATOS EN CHROMADB
// ===============================
async function loadData(collection, propiedades) {
  console.log(`📥 Cargando ${propiedades.length} propiedades en ChromaDB...`)
  
  const BATCH_SIZE = 100
  let loaded = 0
  
  for (let i = 0; i < propiedades.length; i += BATCH_SIZE) {
    const batch = propiedades.slice(i, i + BATCH_SIZE)
    
    const ids = []
    const documents = []
    const metadatas = []
    const embeddings = []
    
    console.log(`\n🧠 Generando embeddings para batch ${Math.floor(i/BATCH_SIZE) + 1}...`)
    
    for (const prop of batch) {
      // ID único
      ids.push(prop.id)
      
      // Documento semántico completo
      const documento = createSemanticDocument(prop)
      documents.push(documento)
      
      // ✨ Generar embedding con OpenAI
      const embedding = await generarEmbedding(documento)
      embeddings.push(embedding)
      
      // Metadatos para filtrado (SIN null)
      const metadata = {
        precio: prop.precio || 0,
        metros: prop.metros || 0,
        habitaciones: prop.habitaciones || 0,
        barrio: prop.ubicacion?.barrio || "",
        ciudad: prop.ubicacion?.ciudad || "",
        tipo_vivienda: prop.atributos?.tipo_vivienda || "",
        certificado_energetico: prop.atributos?.certificado_energetico || "",
        reforma: prop.atributos?.reforma || "",
        orientacion: prop.atributos?.orientacion || "",
        exterior_interior: prop.atributos?.exterior_interior || "",
        url: prop.url || "",
        
        // Características como flags
        tiene_ascensor: prop.atributos?.ascensor || false,
        tiene_terraza: prop.atributos?.terraza || false,
        tiene_balcon: prop.atributos?.balcon || false,
        tiene_garaje: (prop.atributos?.garaje || prop.atributos?.parking) || false,
        tiene_piscina: prop.atributos?.piscina || false,
        amueblado: prop.atributos?.amueblado || false,
        tiene_aire_acondicionado: prop.atributos?.aire_acondicionado || false,
        tiene_calefaccion: prop.atributos?.calefaccion || false
      }
      
      metadatas.push(metadata)
      
      // Mostrar progreso cada 10
      if ((loaded + ids.length) % 10 === 0) {
        process.stdout.write(`\r  ⏳ Procesados: ${loaded + ids.length}/${propiedades.length}`)
      }
    }
    
    // Añadir batch a ChromaDB con embeddings manuales
    try {
      await collection.add({
        ids,
        embeddings,  // ✨ Embeddings generados con OpenAI
        documents,
        metadatas
      })
      
      loaded += batch.length
    } catch (error) {
      console.error(`\n❌ Error en batch ${i}-${i + BATCH_SIZE}:`, error.message)
    }
  }
  
  process.stdout.write('\r' + ' '.repeat(50) + '\r')
  console.log(`✅ ${loaded} propiedades cargadas exitosamente\n`)
}

// ===============================
// 🔍 PRUEBAS DE BÚSQUEDA
// ===============================
async function testSearches(collection) {
  console.log("🔍 PROBANDO BÚSQUEDAS SEMÁNTICAS\n")
  console.log("=".repeat(50))
  
  const queries = [
    {
      text: "piso luminoso con balcón y vista despejada",
      filters: { precio: { $lte: 2000 } }
    },
    {
      text: "apartamento reformado ideal para teletrabajo",
      filters: { habitaciones: { $gte: 2 } }
    },
    {
      text: "vivienda con buena eficiencia energética cerca de parques",
      filters: {}
    }
  ]
  
  for (const [index, query] of queries.entries()) {
    console.log(`\n${index + 1}. Query: "${query.text}"`)
    if (Object.keys(query.filters).length > 0) {
      console.log(`   Filtros: ${JSON.stringify(query.filters)}`)
    }
    console.log("─".repeat(50))
    
    try {
      // ✨ Generar embedding de la query con OpenAI
      const queryEmbedding = await generarEmbedding(query.text)
      
      const results = await collection.query({
        queryEmbeddings: [queryEmbedding],  // ✨ Usar embedding manual
        nResults: 3,
        where: Object.keys(query.filters).length > 0 ? query.filters : undefined
      })
      
      if (results.ids[0].length === 0) {
        console.log("   ❌ No se encontraron resultados")
        continue
      }
      
      for (let i = 0; i < results.ids[0].length; i++) {
        const id = results.ids[0][i]
        const distance = results.distances[0][i]
        const metadata = results.metadatas[0][i]
        const similarity = (1 - distance) * 100
        
        console.log(`\n   ${i + 1}. ID: ${id} (${similarity.toFixed(1)}% similitud)`)
        console.log(`      💰 ${metadata.precio}€ | 🛏️ ${metadata.habitaciones} hab | 📐 ${metadata.metros}m²`)
        console.log(`      📍 ${metadata.barrio || metadata.ciudad}`)
        if (metadata.tipo_vivienda) console.log(`      🏠 ${metadata.tipo_vivienda}`)
        
        // Mostrar características relevantes
        const caracteristicas = []
        if (metadata.tiene_terraza) caracteristicas.push('terraza')
        if (metadata.tiene_balcon) caracteristicas.push('balcón')
        if (metadata.tiene_ascensor) caracteristicas.push('ascensor')
        if (metadata.tiene_garaje) caracteristicas.push('garaje')
        if (metadata.tiene_piscina) caracteristicas.push('piscina')
        if (metadata.amueblado) caracteristicas.push('amueblado')
        
        if (caracteristicas.length > 0) {
          console.log(`      ✅ ${caracteristicas.join(', ')}`)
        }
      }
    } catch (error) {
      console.error(`   ❌ Error en búsqueda: ${error.message}`)
    }
  }
}

// ===============================
// 📊 ESTADÍSTICAS
// ===============================
async function showStatistics(collection) {
  console.log("\n" + "=".repeat(50))
  console.log("📊 ESTADÍSTICAS DEL ÍNDICE VECTORIAL")
  console.log("=".repeat(50))
  
  try {
    const count = await collection.count()
    console.log(`📚 Total de documentos indexados: ${count}`)
    
    console.log("\n✅ ChromaDB listo para búsquedas semánticas")
    console.log("💡 Los embeddings fueron generados con OpenAI (text-embedding-3-small)")
    
  } catch (error) {
    console.error("❌ Error obteniendo estadísticas:", error.message)
  }
}

// ===============================
// 🚀 FUNCIÓN PRINCIPAL
// ===============================
async function main() {
  console.log("🏗️ FASE 3: ÍNDICE VECTORIAL EN CHROMADB (CON OPENAI EMBEDDINGS)")
  console.log("=".repeat(70) + "\n")
  
  // 1. Verificar API key
  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ Error: No se encontró OPENAI_API_KEY")
    process.exit(1)
  }
  
  // 2. Cargar datos del JSON
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ Error: No se encontró ${INPUT_FILE}`)
    console.log("💡 Ejecuta primero normalize_idealista_custom.js")
    process.exit(1)
  }
  
  console.log(`📂 Leyendo ${INPUT_FILE}...`)
  const propiedades = JSON.parse(fs.readFileSync(INPUT_FILE, "utf8"))
  console.log(`✅ ${propiedades.length} propiedades cargadas\n`)
  
  // 3. Conectar a ChromaDB
  const client = await initChromaDB()
  
  // 4. Crear/resetear colección
  const collection = await setupCollection(client, true)
  
  // 5. Cargar datos con embeddings de OpenAI
  const startTime = Date.now()
  await loadData(collection, propiedades)
  const duration = ((Date.now() - startTime) / 1000).toFixed(2)
  console.log(`⏱️ Tiempo de carga: ${duration}s`)
  
  // 6. Estadísticas
  await showStatistics(collection)
  
  // 7. Pruebas de búsqueda
  await testSearches(collection)
  
  console.log("\n🎉 ¡Fase 3 completada exitosamente!")
  console.log("💡 ChromaDB ahora contiene embeddings de todas las propiedades")
  console.log("📍 Siguiente paso: Usar el buscador híbrido")
}

main().catch(error => {
  console.error("\n❌ ERROR FATAL:", error)
  process.exit(1)
})