import fs from "fs";
import neo4j from "neo4j-driver";
import dotenv from "dotenv";

dotenv.config();

// ================================
// CONFIG
// ================================
const INPUT_FILE = "./bbdd/Todas_propiedades.json";

const NEO4J_URI = process.env.NEO4J_URI || "neo4j://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "password";
const NEO4J_DB = "idealista";

// ================================
// CONEXIÓN
// ================================
const driver = neo4j.driver(
  NEO4J_URI,
  neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD)
);

const session = driver.session({ database: NEO4J_DB });

// ================================
// FUNCIÓN PRINCIPAL
// ================================
async function main() {
  console.log("🧹 Borrando base de datos...");
  await session.run("MATCH (n) DETACH DELETE n");

  if (!fs.existsSync(INPUT_FILE)) {
    console.error("❌ No existe el archivo JSON");
    process.exit(1);
  }

  const propiedades = JSON.parse(fs.readFileSync(INPUT_FILE, "utf-8"));

  console.log(`📥 Cargando ${propiedades.length} propiedades en Neo4j...`);

  for (const prop of propiedades) {
    const id = prop.url?.match(/inmueble\/(\d+)/)?.[1];
    if (!id) continue;

    const barrio = prop.barrio || null;
    const ciudad = prop.ciudad || null;

    const precio = prop.price_num || 0;
    const habitaciones = prop.habitaciones || 0;
    const metros = prop.metros || 0;
    const url = prop.url;

    // Crear inmueble
    await session.run(
      `
      MERGE (i:Inmueble {id: $id})
      SET i.precio = $precio,
          i.habitaciones = $habitaciones,
          i.metros = $metros,
          i.url = $url
      `,
      { id, precio, habitaciones, metros, url }
    );

    // Crear zona
    if (ciudad) {
      await session.run(
        `
        MERGE (z:Zona {nombre: $ciudad})
        MERGE (i:Inmueble {id: $id})-[:UBICADO_EN]->(z)
        `,
        { id, ciudad }
      );
    }

    // Crear característica: ascensor / terraza / balcón / garaje
    const caracteristicas = [];

    if (prop.extras?.toLowerCase().includes("ascensor")) caracteristicas.push("ascensor");
    if (prop.extras?.toLowerCase().includes("terraza")) caracteristicas.push("terraza");
    if (prop.extras?.toLowerCase().includes("balcón")) caracteristicas.push("balcon");
    if (prop.caracteristicas_detalle) {
      if (prop.caracteristicas_detalle.some(t => t.toLowerCase().includes("garaje"))) {
        caracteristicas.push("garaje");
      }
    }

    for (const c of caracteristicas) {
      await session.run(
        `
        MERGE (car:Caracteristica {nombre: $c})
        MERGE (i:Inmueble {id: $id})-[:TIENE]->(car)
        `,
        { id, c }
      );
    }
  }

  console.log("🎉 Neo4j cargado correctamente.");
  await session.close();
  await driver.close();
}

main().catch(console.error);
