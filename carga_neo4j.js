import fs from "fs";
import neo4j from "neo4j-driver";
import dotenv from "dotenv";

dotenv.config();

// ================================
// CONFIG
// ================================
const INPUT_FILE = "./bbdd/Propiedades_normalizadas.json";

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

  console.log(`📥 Cargando ${propiedades.length} propiedades en Neo4j...\n`);

  let procesadas = 0;

  for (const prop of propiedades) {
    const id = prop.id;
    if (!id) continue;

    const precio = prop.precio ?? 0;
    const habitaciones = prop.habitaciones ?? 0;
    const metros = prop.metros ?? 0;
    const url = prop.url ?? null;

    // ================================
    // ⚠️ LOS VALORES CORRECTOS ESTÁN EN prop.atributos
    // ================================
    const atr = prop.atributos;

    const planta = atr.planta ?? null;
    const luminosidad = atr.luminosidad ?? null;
    const exterior_interior = atr.exterior_interior ?? null;
    const certificado_energetico = atr.certificado_energetico ?? null;
    const tipo_vivienda = atr.tipo_vivienda ?? null;

    // Crear inmueble con TODOS los atributos normalizados
    await session.run(
      `
      MERGE (i:Inmueble {id: $id})
      SET i.precio = $precio,
          i.habitaciones = $habitaciones,
          i.metros = $metros,
          i.url = $url,
          i.planta = $planta,
          i.luminosidad = $luminosidad,
          i.exterior_interior = $exterior_interior,
          i.certificado_energetico = $certificado_energetico,
          i.tipo_vivienda = $tipo_vivienda
      `,
      {
        id,
        precio: neo4j.int(precio),
        habitaciones: neo4j.int(habitaciones),
        metros: neo4j.int(metros),
        url,
        planta,
        luminosidad,
        exterior_interior,
        certificado_energetico,
        tipo_vivienda
      }
    );

    // UBICACIÓN
    if (prop.ubicacion?.ciudad) {
      await session.run(
        `
        MERGE (z:Zona {nombre: $zona})
        MERGE (i:Inmueble {id: $id})-[:UBICADO_EN]->(z)
        `,
        { id, zona: prop.ubicacion.ciudad }
      );
    }

    // ================================
    // CARGAR CARACTERÍSTICAS NORMALES
    // ================================
    const caracteristicas = [];

    for (const [key, value] of Object.entries(atr)) {
      if (value === true) {
        caracteristicas.push(key);
      }
    }

    for (const car of caracteristicas) {
      await session.run(
        `
        MERGE (c:Caracteristica {nombre: $car})
        MERGE (i:Inmueble {id: $id})-[:TIENE]->(c)
        `,
        { id, car }
      );
    }

    procesadas++;
    if (procesadas % 10 === 0) {
      process.stdout.write(`⏳ Procesadas: ${procesadas}/${propiedades.length} \r`);
    }
  }

  console.log(`\n\n✅ ${procesadas} propiedades cargadas en Neo4j.`);

  // Estadísticas
  const stats = await session.run(`
    MATCH (i:Inmueble)
    OPTIONAL MATCH (i)-[:TIENE]->(c:Caracteristica)
    OPTIONAL MATCH (i)-[:UBICADO_EN]->(z:Zona)
    RETURN count(DISTINCT i) as inmuebles,
           count(DISTINCT z) as zonas,
           count(DISTINCT c) as caracteristicas
  `);

  const record = stats.records[0];
  console.log("\n📊 ESTADÍSTICAS:");
  console.log(`   🏠 Inmuebles: ${record.get('inmuebles').toNumber()}`);
  console.log(`   📍 Zonas: ${record.get('zonas').toNumber()}`);
  console.log(`   🏷️ Características: ${record.get('caracteristicas').toNumber()}`);

  await session.close();
  await driver.close();
}

main().catch(console.error);
