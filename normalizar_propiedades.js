import fs from "fs"
import OpenAI from "openai"
import dotenv from "dotenv"

dotenv.config()

// ===============================
// 🔧 CONFIGURACIÓN
// ===============================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

const INPUT_FILE = "./bbdd/Todas_propiedades.json"
const OUTPUT_FILE = "./bbdd/Propiedades_normalizadas.json"
const BATCH_SIZE = 5
const DELAY_MS = 1000

// ===============================
// 🧠 PROMPT ADAPTADO PARA VENTA
// ===============================
const EXTRACTION_PROMPT = `Eres un experto en análisis inmobiliario de propiedades EN VENTA en España.

Analiza el siguiente anuncio y extrae TODOS los atributos relevantes.

Devuelve ÚNICAMENTE un objeto JSON válido (sin markdown, sin explicaciones):

{
  "ascensor": boolean,
  "terraza": boolean,
  "balcon": boolean,
  "garaje": boolean,
  "parking": boolean,
  "trastero": boolean,
  "amueblado": boolean,
  "aire_acondicionado": boolean,
  "calefaccion": boolean,
  "calefaccion_tipo": string | null,
  "piscina": boolean,
  "jardin": boolean,
  "zona_comunitaria": boolean,
  "mascotas": boolean,
  "cocina_equipada": boolean,
  "armarios_empotrados": boolean,
  "puerta_blindada": boolean,
  "videoportero": boolean,
  "alarma": boolean,
  "accesible": boolean,
  "reforma": string | null ("reformado", "a reformar", "nuevo", "buen estado", "para reformar"),
  "orientacion": string | null,
  "luminosidad": string | null ("muy luminoso", "luminoso", "interior", "exterior con luz natural"),
  "vistas": string | null,
  "planta": string | null ("1ª", "2ª", "bajo", "ático", "entresuelo"),
  "exterior_interior": string | null ("exterior" o "interior"),
  "certificado_energetico": string | null,
  "tipo_vivienda": string | null ("piso", "ático", "dúplex", "estudio", "loft", "casa", "chalet"),
  "antiguedad": string | null,
  "servicios_cercanos": array,
  "caracteristicas_destacadas": array (máximo 5),
  "resumen_semantico": string (descripción limpia del inmueble, 100-150 palabras, enfocada en venta)
}

IMPORTANTE:
- Usa null para valores desconocidos
- Los booleanos deben ser true/false
- Si no se menciona algo, pon false para booleanos y null para strings
- El certificado energético usa la letra que veas (A, B, C, D, E, F, G)
- La planta extráela del campo "extras" o "caracteristicas_detalle"
- Luminosidad: si dice "exterior", "luminoso", "con luz natural" → "muy luminoso" o "luminoso"
- Si dice "ascensor" en extras → ascensor: true`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ===============================
// 🤖 EXTRAER ATRIBUTOS - ADAPTADO
// ===============================
async function extractAttributes(propiedad) {
  // Construir texto completo desde TU estructura
  const textoCompleto = `
TÍTULO: ${propiedad.titulo_completo || ''}
UBICACIÓN: ${propiedad.calle || ''} ${propiedad.barrio || ''} ${propiedad.ciudad || ''}
PRECIO: ${propiedad.price_num ? propiedad.price_num + '€' : 'No especificado'}
HABITACIONES: ${propiedad.habitaciones || 'No especificado'}
METROS: ${propiedad.metros ? propiedad.metros + 'm²' : 'No especificado'}
EXTRAS: ${propiedad.extras || 'Ninguno'}
DESCRIPCIÓN: ${propiedad.descripcion_detallada || 'Sin descripción'}
CARACTERÍSTICAS: ${propiedad.caracteristicas_detalle ? propiedad.caracteristicas_detalle.join(', ') : 'Ninguna'}
CERTIFICADO ENERGÉTICO: ${propiedad.energetico || 'No especificado'}
  `.trim()

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: textoCompleto }
      ],
      temperature: 0.1,
      max_tokens: 1000
    })

    const content = response.choices[0].message.content.trim()
    const jsonText = content
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim()
    
    const attributes = JSON.parse(jsonText)
    return attributes

  } catch (error) {
    console.error(`❌ Error extrayendo atributos:`, error.message)
    return null
  }
}

// ===============================
// 📦 PROCESAR EN LOTES
// ===============================
async function processInBatches(propiedades) {
  const normalized = []
  const total = propiedades.length
  
  console.log(`📊 Total de propiedades a procesar: ${total}\n`)

  for (let i = 0; i < propiedades.length; i += BATCH_SIZE) {
    const batch = propiedades.slice(i, i + BATCH_SIZE)
    console.log(`🔄 Procesando lote ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(total / BATCH_SIZE)} (propiedades ${i + 1}-${Math.min(i + BATCH_SIZE, total)})`)

    const batchPromises = batch.map(async (prop, idx) => {
      const globalIdx = i + idx
      const attributes = await extractAttributes(prop)
      
      if (attributes) {
        console.log(`  ✅ ${globalIdx + 1}/${total} - ${prop.ciudad || 'Sin ciudad'}, ${prop.barrio || 'Sin barrio'}`)
        
        // Adaptar a la estructura esperada por el sistema
        return {
          id: `prop_${globalIdx + 1}`,
          ubicacion: {
            calle: prop.calle || null,
            barrio: prop.barrio || null,
            ciudad: prop.ciudad || null
          },
          precio: prop.price_num || null,
          habitaciones: prop.habitaciones || null,
          metros: prop.metros || null,
          url: prop.url || null,
          
          // Texto original
          descripcion_original: prop.descripcion_detallada || null,
          extras_originales: prop.extras || null,
          caracteristicas_originales: prop.caracteristicas_detalle || [],
          
          // Atributos normalizados extraídos por IA
          atributos: attributes
        }
      } else {
        console.log(`  ⚠️ ${globalIdx + 1}/${total} - Error procesando, se omitirá`)
        return null
      }
    })

    const batchResults = await Promise.all(batchPromises)
    normalized.push(...batchResults.filter(r => r !== null))

    // Guardar progreso incremental
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(normalized, null, 2), "utf8")
    console.log(`💾 Progreso guardado: ${normalized.length}/${total} propiedades\n`)

    if (i + BATCH_SIZE < propiedades.length) {
      await sleep(DELAY_MS)
    }
  }

  return normalized
}

// ===============================
// 🚀 FUNCIÓN PRINCIPAL
// ===============================
async function main() {
  console.log("🏠 NORMALIZACIÓN DE CORPUS INMOBILIARIO (IDEALISTA CUSTOM)\n")
  console.log("=".repeat(50))

  // Verificar API key
  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ Error: No se encontró OPENAI_API_KEY en el archivo .env")
    console.log("Crea un archivo .env con: OPENAI_API_KEY=tu_api_key_aqui")
    process.exit(1)
  }

  // Leer archivo de entrada
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ Error: No se encontró el archivo ${INPUT_FILE}`)
    process.exit(1)
  }

  console.log(`📂 Leyendo ${INPUT_FILE}...`)
  const propiedades = JSON.parse(fs.readFileSync(INPUT_FILE, "utf8"))
  console.log(`✅ ${propiedades.length} propiedades cargadas\n`)

  // Procesar
  const startTime = Date.now()
  const normalized = await processInBatches(propiedades)
  const duration = ((Date.now() - startTime) / 1000).toFixed(2)

  // Resultados finales
  console.log("\n" + "=".repeat(50))
  console.log("✨ NORMALIZACIÓN COMPLETADA")
  console.log("=".repeat(50))
  console.log(`📊 Total procesado: ${normalized.length}/${propiedades.length} propiedades`)
  console.log(`⏱️ Tiempo total: ${duration}s`)
  console.log(`💾 Archivo guardado en: ${OUTPUT_FILE}`)
  
  // Estadísticas de atributos
  console.log("\n📈 ESTADÍSTICAS DE ATRIBUTOS DETECTADOS:")
  const stats = {
    ascensor: 0,
    terraza: 0,
    balcon: 0,
    garaje: 0,
    amueblado: 0,
    aire_acondicionado: 0,
    calefaccion: 0,
    luminoso: 0,
    exterior: 0,
    reformado: 0
  }

  normalized.forEach(prop => {
    if (prop.atributos.ascensor) stats.ascensor++
    if (prop.atributos.terraza) stats.terraza++
    if (prop.atributos.balcon) stats.balcon++
    if (prop.atributos.garaje || prop.atributos.parking) stats.garaje++
    if (prop.atributos.amueblado) stats.amueblado++
    if (prop.atributos.aire_acondicionado) stats.aire_acondicionado++
    if (prop.atributos.calefaccion) stats.calefaccion++
    if (prop.atributos.luminosidad?.includes('luminoso')) stats.luminoso++
    if (prop.atributos.exterior_interior === 'exterior') stats.exterior++
    if (prop.atributos.reforma === "reformado") stats.reformado++
  })

  Object.entries(stats).forEach(([key, value]) => {
    const percentage = ((value / normalized.length) * 100).toFixed(1)
    console.log(`  • ${key}: ${value} (${percentage}%)`)
  })

  // Mostrar ejemplos de salida
  console.log("\n📝 EJEMPLO DE PROPIEDAD NORMALIZADA:")
  if (normalized.length > 0) {
    const ejemplo = normalized[0]
    console.log(`\nID: ${ejemplo.id}`)
    console.log(`Ubicación: ${ejemplo.ubicacion.ciudad}`)
    console.log(`Precio: ${ejemplo.precio}€`)
    console.log(`Habitaciones: ${ejemplo.habitaciones}`)
    console.log(`Metros: ${ejemplo.metros}m²`)
    console.log(`\nAtributos extraídos:`)
    console.log(`  - Ascensor: ${ejemplo.atributos.ascensor}`)
    console.log(`  - Terraza: ${ejemplo.atributos.terraza}`)
    console.log(`  - Luminosidad: ${ejemplo.atributos.luminosidad}`)
    console.log(`  - Planta: ${ejemplo.atributos.planta}`)
    console.log(`  - Exterior/Interior: ${ejemplo.atributos.exterior_interior}`)
    console.log(`  - Certificado: ${ejemplo.atributos.certificado_energetico}`)
    console.log(`\nResumen semántico:`)
    console.log(`  ${ejemplo.atributos.resumen_semantico?.substring(0, 150)}...`)
  }

  console.log("\n🎉 ¡Proceso completado exitosamente!")
  console.log("\n💡 Próximos pasos:")
  console.log("   1. Ejecuta: node load_neo4j_complete.js")
  console.log("   2. Ejecuta: node load_chromadb.js")
  console.log("   3. Ejecuta: node asistente_inmobiliario.js")
}

main().catch(error => {
  console.error("\n❌ ERROR FATAL:", error)
  process.exit(1)
})