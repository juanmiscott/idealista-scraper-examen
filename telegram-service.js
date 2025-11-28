import TelegramBot from "node-telegram-bot-api";
import { PassThrough } from "stream";
import fs from "fs";
import { buscarInmueblesHibrido } from "./buscador_hibrido.js";

import https from "https";

class TelegramService {
  constructor(telegramToken, chatId = null) {
    this.token = telegramToken;
    this.chatId = chatId;
    this.bot = new TelegramBot(this.token, { polling: true });

    this.bot.on("message", async (msg) => {
      const chatId = msg.chat.id;

      if (msg.text && msg.text.startsWith("/buscar")) {
        const query = msg.text.split(" ").slice(1).join(" ");
        await this.search(chatId, query);
      }

      if (msg.photo) {
        await this.analyzeImage(msg, chatId);
      }

      if (msg.voice) {
        await this.analyzeAudio(msg, chatId);
      }
    });
  }

async search(chatId, query) {

  const resultado = await buscarInmueblesHibrido(query);

  if (resultado.error) {
    await this.sendMessage(chatId, "No pude entender tu consulta.");
    return;
  }

  if (!resultado.resultados || resultado.resultados.length === 0) {
    await this.sendMessage(chatId, "No encontré inmuebles que coincidan.");
    return;
  }

  // Enviar explicación generada por GPT (más natural)
  await this.sendMessage(chatId, resultado.explicacion);

  // Enviar 3–5 inmuebles en formato corto
  const top = resultado.resultados.slice(0, 5);

  for (const inm of top) {
    const mensaje = 
      `🏠 *${inm.tipo_vivienda || "Inmueble"}*\n` +
      `📍 Zona: ${inm.zona || "no indicada"}\n` +
      `💶 Precio: ${inm.precio} €/mes\n` +
      `📐 ${inm.metros} m² - ${inm.habitaciones} habitaciones\n` +
      `✨ ${inm.caracteristicas?.slice(0, 5).join(", ") || "sin características"}\n` +
      (inm.url ? `🔗 [Ver anuncio](${inm.url})` : "");

    await this.sendMessage(chatId, mensaje);
  }
}

  async sendAdminMessage(message) {
    try {
      await this.bot.sendMessage(this.chatId, message);
    } catch (error) {
      console.error("Error al enviar mensaje al admin:", error);
    }
  }

  async sendMessage(chatId, message) {
    try {
      await this.bot.sendMessage(chatId, message);
    } catch (error) {
      console.error("Error al enviar mensaje:", error);
    }
  }

  async analyzeImage(message, chatId) {
    const fileId = message.photo[message.photo.length - 1].file_id;

    try {
      const fileUrl = await this.bot.getFileLink(fileId);
      console.log("URL de la imagen:", fileUrl);

      await this.sendMessage(chatId, "He recibido una imagen 👀");
    } catch (error) {
      console.error("Error al obtener la imagen:", error);
    }
  }

  async analyzeAudio(msg, chatId) {
    const fileId = msg.voice.file_id;
    const fileUrl = await this.bot.getFileLink(fileId);

    await this.sendMessage(chatId, "He recibido un audio, descargándolo…");

    const file = await this.downloadAudioAsStream(fileUrl);

    await this.sendMessage(chatId, "Audio descargado correctamente 🎧");
  }

  async downloadAudioAsStream(url) {
    return new Promise((resolve, reject) => {
      const stream = new PassThrough();
      const filePath = "./tempAudio.oga";
      const fileStream = fs.createWriteStream(filePath);

      https
        .get(url, (response) => {
          if (response.statusCode === 200) {
            response.pipe(stream);
            stream.pipe(fileStream);

            fileStream.on("finish", () => {
              fileStream.close();
              resolve(fileStream);
            });
          } else {
            reject(
              new Error(`Error al descargar el audio: ${response.statusCode}`)
            );
          }
        })
        .on("error", (err) => reject(err));
    });
  }
}

export default TelegramService;
