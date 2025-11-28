import fs from "fs";
import { ChromaClient } from "chromadb";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// CONFIG
const INPUT_FILE = "./bbdd/Todas_propiedades.json";
const COLLECTION_NAME = "inmuebles_idealista";
const CHROMA_URL = "http://localhost:8000";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Crear documento semántico
function createSemanticDocument(prop) {
  const parts = [];

  const tipo = "Piso";
  const zona = prop.barrio || prop.ciudad || "zona desconocida";

  parts.push(`${tipo} en ${zona}`);

  if (prop.descripcion_detallada) parts.push(prop.descripcion_detallada);

  const detalles = [];
  if (prop.habitaciones) detalles.push(`${prop.habitaciones} habitaciones`);
  if (prop.metros) detalles.push(`${prop.metros} m²`);
  if (prop.price_num) detalles.push(`${prop.price_num} €/mes`);

  if (detalles.length > 0) parts.push(detalles.join(", "));

  return parts.join(". ");
}

async function generarEmbedding(texto) {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texto
  });

  return res.data[0].embedding;
}

async function main() {
  console.log("🏗️ Re-indexando ChromaDB...");
  console.log("====================================");

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ Archivo no encontrado: ${INPUT_FILE}`);
    process.exit(1);
  }

  const propiedades = JSON.parse(fs.readFileSync(INPUT_FILE, "utf8"));
  console.log(`📂 Leídas ${propiedades.length} propiedades.`);
  // 🧹 ELIMINAR DUPLICADOS POR ID (via URL)
const vistos = new Set();
const propiedadesUnicas = [];

for (const prop of propiedades) {
  const id = prop.url?.match(/inmueble\/(\d+)/)?.[1];
  if (!id) continue;

  if (!vistos.has(id)) {
    vistos.add(id);
    propiedadesUnicas.push(prop);
  }
}

console.log(`🔍 Propiedades únicas después de limpiar: ${propiedadesUnicas.length}`);

  const client = new ChromaClient({
    path: CHROMA_URL
  });

  console.log("🔌 Conectado a ChromaDB.");

  try {
    await client.deleteCollection({ name: COLLECTION_NAME });
    console.log("🧹 Colección antigua eliminada.");
  } catch {}

  const collection = await client.createCollection({
    name: COLLECTION_NAME
  });

  console.log("📦 Nueva colección creada.");

  const ids = [];
  const metadatas = [];
  const embeddings = [];

  console.log("🧠 Generando embeddings...");

for (const prop of propiedadesUnicas) {
    // EXTRAER ID DESDE LA URL
    const id = prop.url?.match(/inmueble\/(\d+)/)?.[1];
    if (!id) continue; // si no existe, saltar

    ids.push(id);

    const texto = createSemanticDocument(prop);
    const embedding = await generarEmbedding(texto);

    embeddings.push(embedding);

    metadatas.push({
      precio: prop.price_num || 0,
      habitaciones: prop.habitaciones || 0,
      metros: prop.metros || 0,
      zona: prop.barrio || prop.ciudad || "",
      url: prop.url
    });
  }

  console.log("📤 Subiendo a Chroma...");

  await collection.add({
    ids,
    embeddings,
    metadatas
  });

  console.log(`🎉 Insertados ${ids.length} embeddings.`);

  const test = await collection.query({
    queryEmbeddings: [
      await generarEmbedding("piso luminoso con terraza en Palma")
    ],
    nResults: 1
  });

  console.log("\n🧪 Test de búsqueda:", test.ids[0]?.length > 0 ? "OK" : "FALLO");
}

main().catch(console.error);
