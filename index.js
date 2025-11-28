import dotenv from 'dotenv';
dotenv.config();

import TelegramService from './telegram-service.js';

const bot = new TelegramService(process.env.TELEGRAM_ADMIN_TOKEN);

console.log("Bot de Telegram iniciado...");
