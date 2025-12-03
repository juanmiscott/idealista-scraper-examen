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
// FUNCIÓN AUXILIAR: EXTRAER PLANTA
// ================================
function extractPlanta(prop) {
  const extras = prop.extras || "";
  const match = extras.match(/Planta\s+(\d+)ª|planta\s+(\w+)/i);
  if (match) return match[1] || match[2];
  
  const carac = prop.caracteristicas_detalle || [];
  for (const c of carac) {
    const m = c.match(/Planta\s+(\d+)ª|planta\s+(\w+)/i);
    if (m) return m[1] || m[2];
  }
  
  return null;
}

// ================================
// FUNCIÓN AUXILIAR: LUMINOSIDAD
// ================================
function extractLuminosidad(prop) {
  const texto = [
    prop.titulo_completo,
    prop.descripcion_detallada,
    prop.extras,
    ...(prop.caracteristicas_detalle || [])
  ].join(" ").toLowerCase();
  
  if (texto.includes("muy luminoso") || texto.includes("mucha luz")) {
    return "muy luminoso";
  }
  if (texto.includes("luminoso") || texto.includes("luz natural")) {
    return "luminoso";
  }
  if (texto.includes("exterior")) {
    return "luminoso";
  }
  
  return null;
}

// ================================
// FUNCIÓN AUXILIAR: EXTERIOR/INTERIOR
// ================================
function extractExteriorInterior(prop) {
  const extras = (prop.extras || "").toLowerCase();
  const carac = (prop.caracteristicas_detalle || []).join(" ").toLowerCase();
  
  if (extras.includes("exterior") || carac.includes("exterior")) {
    return "exterior";
  }
  if (extras.includes("interior") || carac.includes("interior")) {
    return "interior";
  }
  
  return null;
}

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

  let procesadas = 0;

  for (const prop of propiedades) {
    const id = prop.url?.match(/inmueble\/(\d+)/)?.[1];
    if (!id) continue;

    const barrio = prop.barrio || null;
    const ciudad = prop.ciudad || null;

    const precio = prop.price_num || 0;
    const habitaciones = prop.habitaciones || 0;
    const metros = prop.metros || 0;
    const url = prop.url;
    
    // Extraer atributos adicionales
    const planta = extractPlanta(prop);
    const luminosidad = extractLuminosidad(prop);
    const exterior_interior = extractExteriorInterior(prop);
    const certificado_energetico = prop.energetico || null;

    // Crear inmueble con TODOS los atributos
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
          i.certificado_energetico = $certificado_energetico
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
        certificado_energetico
      }
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

    // Extraer características (mejorado)
    const caracteristicas = new Set();

    const textoCompleto = [
      prop.extras || "",
      prop.titulo_completo || "",
      ...(prop.caracteristicas_detalle || [])
    ].join(" ").toLowerCase();

    // Características comunes
    if (textoCompleto.includes("ascensor")) caracteristicas.add("ascensor");
    if (textoCompleto.includes("terraza")) caracteristicas.add("terraza");
    if (textoCompleto.includes("balcón") || textoCompleto.includes("balcon")) {
      caracteristicas.add("balcon");
    }
    if (textoCompleto.includes("garaje") || textoCompleto.includes("parking")) {
      caracteristicas.add("garaje");
    }
    if (textoCompleto.includes("piscina")) caracteristicas.add("piscina");
    if (textoCompleto.includes("aire acondicionado")) {
      caracteristicas.add("aire_acondicionado");
    }
    if (textoCompleto.includes("calefacción") || textoCompleto.includes("calefaccion")) {
      caracteristicas.add("calefaccion");
    }
    if (textoCompleto.includes("amueblado")) caracteristicas.add("amueblado");
    if (textoCompleto.includes("trastero")) caracteristicas.add("trastero");
    if (textoCompleto.includes("armarios empotrados")) {
      caracteristicas.add("armarios_empotrados");
    }

    // Crear nodos de características
    for (const c of caracteristicas) {
      await session.run(
        `
        MERGE (car:Caracteristica {nombre: $c})
        MERGE (i:Inmueble {id: $id})-[:TIENE]->(car)
        `,
        { id, c }
      );
    }

    procesadas++;
    if (procesadas % 10 === 0) {
      process.stdout.write(`\r  ⏳ Procesadas: ${procesadas}/${propiedades.length}`);
    }
  }

  console.log(`\n✅ ${procesadas} propiedades cargadas en Neo4j.`);

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

  // Top características
  const topCarac = await session.run(`
    MATCH (i:Inmueble)-[:TIENE]->(c:Caracteristica)
    RETURN c.nombre as caracteristica, count(i) as cantidad
    ORDER BY cantidad DESC
    LIMIT 5
  `);

  console.log("\n🔝 TOP 5 CARACTERÍSTICAS:");
  topCarac.records.forEach((r, idx) => {
    console.log(`   ${idx + 1}. ${r.get('caracteristica')}: ${r.get('cantidad').toNumber()}`);
  });

  await session.close();
  await driver.close();
}

main().catch(console.error);