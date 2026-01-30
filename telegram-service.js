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
  try {
    if (!query || query.trim().length === 0) {
      await this.sendMessage(chatId, "Escribe algo como:\n/buscar piso con ascensor y luminoso en Palma");
      return;
    }

    await this.sendMessage(chatId, "🔎 Buscando pisos que encajen con tu descripción...");

    // ESTA ES LA VARIABLE CORRECTA
    const { resultados, explicacion } = await buscarInmueblesHibrido(query);

    // Si no hay estructurados, pero sí hay candidatos semánticos
    if (!resultados || resultados.length === 0) {
      await this.sendMessage(
        chatId,
        "No encontré coincidencias exactas, pero puedo enseñarte opciones similares si amplías un poco tu búsqueda."
      );
      return;
    }

    // Enviar explicación generada por IA
    if (explicacion) {
      await this.sendMessage(chatId, explicacion);
    }

    // Enviar top 5 resultados
    // No enviamos fichas individuales. Solo la respuesta resumida de GPT.


  } catch (err) {
    console.error("❌ Error en búsqueda desde Telegram:", err);
    await this.sendMessage(chatId, "Ha ocurrido un error buscando pisos. Inténtalo de nuevo.");
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
