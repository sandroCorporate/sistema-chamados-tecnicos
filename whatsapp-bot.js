import baileysPkg from '@whiskeysockets/baileys';
import dotenv from 'dotenv';
import express from 'express';
import db from './db.js';
import pino from 'pino';
import crypto from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// Insira o seu número com código do país e DDI (ex: 5592999999999)
const PHONE_NUMBER = process.env.WHATSAPP_PHONE || "5592986040401";

app.use(express.json());

const baileysModule = baileysPkg.default || baileysPkg;
const makeWASocket = typeof baileysModule === 'function' ? baileysModule : (baileysModule.default || baileysModule.makeWASocket);
const DisconnectReason = baileysModule.DisconnectReason || baileysModule.default?.DisconnectReason || { loggedOut: 401 };

async function usePostgresAuthState(dbClient) {
  await dbClient.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const writeData = async (data, key) => {
    const serialized = JSON.stringify(data, (k, v) => Buffer.isBuffer(v) ? { type: 'Buffer', data: v.toString('base64') } : v);
    await dbClient.query(
      `INSERT INTO whatsapp_auth (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, serialized]
    );
  };

  const readData = async (key) => {
    try {
      const { rows } = await dbClient.query('SELECT value FROM whatsapp_auth WHERE key = \$1', [key]);
      if (rows.length === 0) return null;
      return JSON.parse(rows[0].value, (k, v) => {
        if (v !== null && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) {
          return Buffer.from(v.data);
        }
        if (v !== null && typeof v === 'object' && v.type === 'Buffer' && typeof v.data === 'string') {
          return Buffer.from(v.data, 'base64');
        }
        return v;
      });
    } catch (error) {
      return null;
    }
  };

  const removeData = async (key) => {
    try {
      await dbClient.query('DELETE FROM whatsapp_auth WHERE key = \$1', [key]);
    } catch (error) {}
  };

  let creds;
  const storedCreds = await readData('creds');
  
  if (storedCreds) {
    creds = storedCreds;
  } else {
    const initAuthCreds = baileysModule.initAuthCreds || baileysModule.default?.initAuthCreds || baileysPkg.initAuthCreds;
    creds = typeof initAuthCreds === 'function' ? initAuthCreds() : {
      registrationId: Math.floor(Math.random() * 1000000),
      noiseKey: { public: crypto.randomBytes(32), private: crypto.randomBytes(32) },
      signedIdentityKey: { public: crypto.randomBytes(32), private: crypto.randomBytes(32) },
      signedPreKey: {
        keyPair: { public: crypto.randomBytes(32), private: crypto.randomBytes(32) },
        signature: crypto.randomBytes(64),
        keyId: 1
      },
      registrationState: {},
      advSecretKey: crypto.randomBytes(32),
      processedHistoryMessages: [],
      nextPreKeyId: 1,
      firstUnuploadedPreKeyId: 1,
      accountSettings: { unarchiveChats: false }
    };
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const value = await readData(`${type}-${id}`);
            if (value) data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) await writeData(value, key);
              else await removeData(key);
            }
          }
        }
      }
    },
    saveCreds: () => writeData(creds, 'creds')
  };
}

let sockWA = null;
async function iniciarWhatsApp() {
  try {
    console.log('[WhatsApp Bot] A inicializar socket com suporte a Pairing Code...');
    const { state, saveCreds } = await usePostgresAuthState(db);

    sockWA = makeWASocket({
      version: [2, 3000, 1015901307],
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['Chrome (Linux)', 'Chrome', '120.0.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sockWA.ev.on('creds.update', saveCreds);

    // Se não estiver registcado/parecido, solicita o código por número
    if (!sockWA.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sockWA.requestPairingCode(PHONE_NUMBER);
          console.log('\n==================================================');
          console.log(`[WhatsApp Bot] CÓDIGO DE EMPARELHAMENTO GERADO: ${code}`);
          console.log('==================================================\n');
        } catch (err) {
          console.error('[Pairing Error]:', err.message);
        }
      }, 5000);
    }

    sockWA.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        console.log('[WhatsApp Bot] Conectado com sucesso ao WhatsApp!');
      } else if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`[WhatsApp Bot] Conexão fechada. Código de estado: ${statusCode}`);
        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => iniciarWhatsApp(), 5000);
        }
      }
    });
  } catch (err) {
    console.error('[WhatsApp Bot Init Error]:', err.message);
  }
}

app.post('/enviar', async (req, res) => {
  const { jid, mensagem } = req.body;
  if (!sockWA) {
    return res.status(503).json({ error: 'Socket do WhatsApp não inicializado.' });
  }

  try {
    await sockWA.sendMessage(jid, { text: mensagem });
    return res.json({ sucesso: true, mensagem: 'Mensagem enviada com sucesso.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Microserviço a rodar na porta ${PORT}`);
  iniciarWhatsApp();
});
