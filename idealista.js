import { exec } from "child_process"
import { Builder, By, until } from "selenium-webdriver"
import chrome from "selenium-webdriver/chrome.js"
import fs from "fs"
import net from "net"
import readline from "readline"

// ======================================================
// 💬 PEDIR URL POR TERMINAL
// ======================================================
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

rl.question("👉 Ingresa la URL de Idealista (máx. 1800 anuncios): ", url => {
  if (!/^https?:\/\//i.test(url)) {
    console.log("⚠️ La URL debe comenzar con http o https.")
    rl.close()
    return
  }
  rl.close()
  idealista(url)
})

// ======================================================
// 🛠 UTILIDADES
// ======================================================
const sleep = ms => new Promise(r => setTimeout(r, ms))
const random = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

const media = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0

const mediana = arr => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const moda = arr => {
  if (!arr.length) return 0
  const freq = {}
  arr.forEach(n => freq[n] = (freq[n] || 0) + 1)
  return Number(Object.keys(freq).reduce((a, b) => freq[a] >= freq[b] ? a : b))
}

// ======================================================
// 🧠 ESPERAR PUERTO DE DEBUG
// ======================================================
function waitForPort(port = 9222, timeout = 15000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      const socket = new net.Socket()
      socket
        .once("connect", () => { socket.destroy(); resolve(true) })
        .once("error", () => {
          socket.destroy()
          if (Date.now() - start > timeout) reject(new Error("⏰ Timeout esperando puerto 9222"))
          else setTimeout(check, 400)
        })
        .connect(port, "127.0.0.1")
    }
    check()
  })
}

// ======================================================
// 🖱️ SCROLL HUMANO
// ======================================================
async function humanScroll(driver) {
  for (let i = 0; i < random(3, 6); i++) {
    await driver.executeScript(`window.scrollBy(0, ${random(500, 900)});`)
    await sleep(random(700, 1600))
  }
}

// ======================================================
// 🍪 ACEPTAR COOKIES
// ======================================================
async function aceptarCookies(driver) {
  try {
    const btn = await driver.wait(
      until.elementLocated(By.id("didomi-notice-agree-button")),
      5000
    )
    await driver.executeScript("arguments[0].scrollIntoView()", btn)
    await sleep(400)
    await btn.click()
  } catch { }
}

// ======================================================
// 🧩 PARSE DIRECCIÓN
// ======================================================
function parseDireccion(texto) {
  if (!texto) return { calle: "", barrio: "", ciudad: "" }

  let clean = texto
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()

  const idx = clean.toLowerCase().indexOf(" en ")
  if (idx !== -1) clean = clean.substring(idx + 4).trim()

  const partes = clean.split(/,| - /).map(s => s.trim()).filter(Boolean)

  let calle = "", barrio = "", ciudad = ""

  if (partes.length === 1) ciudad = partes[0]
  if (partes.length === 2) { barrio = partes[0]; ciudad = partes[1] }
  if (partes.length >= 3) {
    calle = partes[0]
    barrio = partes[1]
    ciudad = partes.slice(2).join(", ")
  }

  const cap = s => s ? s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : ""

  return {
    calle: cap(calle),
    barrio: cap(barrio),
    ciudad: cap(ciudad)
  }
}

// ======================================================
// 🏠 EXTRAER DETALLES DEL ANUNCIO
// ======================================================
async function extraerDetalles(driver, url) {
  await driver.get(url)
  await sleep(1500)

  // Descripción completa
  let descripcion_detallada = ""
  try {
    const p = await driver.findElement(By.css(".comment p"))
    descripcion_detallada = (await p.getAttribute("innerHTML"))
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?p>/gi, "")
      .trim()
  } catch { }

  // Características reales
  const caracteristicas = []
  try {
    const bloques = await driver.findElements(By.css(
      "#details .details-property-feature-one li, #details .details-property-feature-two li"
    ))

    for (const li of bloques) {
      const txt = (await li.getText()).trim()
      if (txt.length > 1) caracteristicas.push(txt)
    }
  } catch { }

  // Certificado energético
  // Certificado energético REAL leyendo la clase del icono
  let energetico = "";
  try {
    const icon = await driver.findElement(By.css("span[class*='icon-energy']"));
    const clase = await icon.getAttribute("class");   // ej: "icon-energy-c-c"

    // Extraer letra principal (A, B, C...)
    const match = clase.match(/icon-energy-([a-g])/i);

    if (match) energetico = match[1].toUpperCase();
    else energetico = clase; // fallback por si cambia
  } catch { }

  return { descripcion_detallada, caracteristicas, energetico }
}

// ======================================================
// 🚀 FUNCIÓN PRINCIPAL
// ======================================================
async function idealista(urlBase) {
  const profile = "C:\\temp\\ChromeProfile"
  if (!fs.existsSync(profile)) fs.mkdirSync(profile, { recursive: true })

  console.log("🌐 Iniciando Chrome con depuración...")
  exec(`"${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="${profile}" --start-maximized`)

  await waitForPort()

  const options = new chrome.Options()
  options.options_["debuggerAddress"] = "127.0.0.1:9222"

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build()

  if (!fs.existsSync("./bbdd")) fs.mkdirSync("./bbdd")

  const propiedades = []

  console.log("📍 Abriendo:", urlBase)
  await driver.get(urlBase)
  await aceptarCookies(driver)

  await driver.wait(until.elementLocated(By.css("div.item-info-container")), 15000)

  let page = 1

  while (true) {
    console.log(`📄 Página ${page}`)

    await humanScroll(driver)

    let items = await driver.findElements(By.css("div.item-info-container"))
    if (!items.length) break

    for (let i = 0; i < items.length; i++) {

      // 🔥 FIX REAL – recargar lista siempre para evitar STALE ELEMENT
      items = await driver.findElements(By.css("div.item-info-container"))
      const item = items[i]

      try {
        const tituloCompleto = await item.findElement(By.css("a.item-link")).getText().catch(() => "")
        const priceText = await item.findElement(By.css("span.item-price")).getText().catch(() => "")
        const priceNum = parseInt(priceText.replace(/[^\d]/g, ""), 10) || null
        const link = await item.findElement(By.css("a.item-link")).getAttribute("href").catch(() => "")

        const detailsEls = await item.findElements(By.xpath(".//span[@class='item-detail']"))
        const details = await Promise.all(detailsEls.map(d => d.getText()))

        let habitaciones = null, metros = null, extrasArray = []

        for (const d of details) {
          if (/hab/i.test(d)) habitaciones = parseInt(d)
          else if (/m²/i.test(d)) metros = parseInt(d)
          else extrasArray.push(d)
        }

        const extras = extrasArray.join(" | ")

        const { calle, barrio, ciudad } = parseDireccion(tituloCompleto)
        const garaje = /garaje|parking/i.test(extras) ? "Garaje incluido" : ""

        // 🔥 ENTRAR EN EL ANUNCIO
        const detalles = await extraerDetalles(driver, link)

        propiedades.push({
          titulo_completo: tituloCompleto,
          calle,
          barrio,
          ciudad,
          price_num: priceNum,
          habitaciones,
          metros,
          extras,
          garaje,
          url: link,
          descripcion_detallada: detalles.descripcion_detallada,
          caracteristicas_detalle: detalles.caracteristicas,
          energetico: detalles.energetico
        })

        // Volver atrás
        await driver.navigate().back()
        await sleep(1500)

      } catch (e) {
        console.log("❌ Error en anuncio:", e.message)
      }
    }

    let next
    try { next = await driver.findElement(By.css("li.next:not(.disabled) a")) } catch { }
    if (!next) break

    await driver.executeScript("arguments[0].scrollIntoView()", next)
    await sleep(1000)
    await next.click()
    await sleep(1800)

    page++
  }

  await driver.quit()

  fs.writeFileSync("./bbdd/Todas_propiedades.json", JSON.stringify(propiedades, null, 2))
  console.log(`💾 Guardadas ${propiedades.length} viviendas.`)

  // ======================================================
  // 📊 ESTADÍSTICAS
  // ======================================================
  const stats = propiedades.reduce((acc, casa) => {
    const ciudad = casa.ciudad || "Desconocido"
    const hab = casa.habitaciones || "sin_habitaciones"

    acc[ciudad] ??= {}
    acc[ciudad][hab] ??= { precios: [], metros: [] }

    if (casa.price_num) acc[ciudad][hab].precios.push(casa.price_num)
    if (casa.metros) acc[ciudad][hab].metros.push(casa.metros)

    return acc
  }, {})

  for (const ciudad in stats) {
    for (const hab in stats[ciudad]) {
      const { precios, metros } = stats[ciudad][hab]
      stats[ciudad][hab] = {
        precio: {
          media: Math.round(media(precios)),
          mediana: Math.round(mediana(precios)),
          moda: moda(precios)
        },
        metros: {
          media: Math.round(media(metros)),
          mediana: Math.round(mediana(metros)),
          moda: moda(metros)
        }
      }
    }
  }

  fs.writeFileSync("./bbdd/Estadisticas.json", JSON.stringify(stats, null, 2))
  console.log("📈 Estadísticas generadas correctamente.")
  console.log("✅ Scraping finalizado.")
}
