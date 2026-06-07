import pkg from '@whiskeysockets/baileys';
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = pkg;
import QRCode from 'qrcode';
import express from 'express';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { consultarCI } from './scraper.js';

const AUTH_DIR   = process.env.AUTH_DIR || '/app/auth_info';
const GROUP_FILE = path.join(AUTH_DIR, 'selected_group.json');
const QR_FILE    = path.join(AUTH_DIR, 'qr.png');
const PORT       = process.env.PORT || 3000;
const CI_REGEX   = /\bci[:\s]*([0-9][.0-9]*[0-9]+)/i;

let activeGroupJid = process.env.GROUP_JID || null;
let botConnected   = false;
let sockRef        = null; // referencia global para endpoints HTTP

// ── Servidor HTTP ─────────────────────────────────────────────────────────────

const app = express();

app.get('/qr', (req, res) => {
  if (botConnected) {
    return res.status(200).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>✅ Bot ya conectado</h2>
        <p>El bot está activo. No hay QR para mostrar.</p>
      </body></html>
    `);
  }
  if (!fs.existsSync(QR_FILE)) {
    return res.status(404).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>⏳ Generando QR...</h2>
        <p>Refrescá en unos segundos.</p>
        <script>setTimeout(() => location.reload(), 3000)</script>
      </body></html>
    `);
  }
  res.send(`
    <html><head>
      <meta http-equiv="refresh" content="20">
      <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5}
      img{border:8px solid white;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.15)}</style>
    </head><body>
      <h2>📱 Escaneá con WhatsApp</h2>
      <p>WhatsApp → ⋮ → Dispositivos vinculados → Vincular dispositivo</p>
      <img src="/qr.png?t=${Date.now()}" width="300" height="300"><br><br>
      <small>El QR se actualiza automáticamente cada 20 s</small>
    </body></html>
  `);
});

app.get('/qr.png', (req, res) => {
  if (!fs.existsSync(QR_FILE)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(QR_FILE).pipe(res);
});

app.get('/status', (req, res) => {
  res.json({ connected: botConnected, group: activeGroupJid });
});

// Listar todos los grupos disponibles
app.get('/groups', async (req, res) => {
  if (!botConnected || !sockRef) return res.status(503).json({ error: 'Bot no conectado aún' });
  const chats  = await sockRef.groupFetchAllParticipating();
  const groups = Object.values(chats).map(g => ({ jid: g.id, name: g.subject }));
  res.json(groups);
});

// Activar bot en un grupo por nombre exacto (o parcial)
app.get('/activate', async (req, res) => {
  if (!botConnected || !sockRef) return res.status(503).json({ error: 'Bot no conectado aún' });
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'Parámetro ?name= requerido' });

  const chats  = await sockRef.groupFetchAllParticipating();
  const groups = Object.values(chats).map(g => ({ jid: g.id, name: g.subject }));

  // Buscar por nombre exacto primero, luego parcial (case-insensitive)
  const match =
    groups.find(g => g.name === name) ||
    groups.find(g => g.name.toLowerCase().includes(name.toLowerCase()));

  if (!match) {
    return res.status(404).json({
      error: `Grupo "${name}" no encontrado`,
      grupos_disponibles: groups.map(g => g.name),
    });
  }

  activeGroupJid = match.jid;
  saveGroupJid(match.jid);
  console.log(`✅ Grupo activado vía HTTP: "${match.name}" | ${match.jid}`);
  res.json({ ok: true, grupo: match.name, jid: match.jid });
});

app.listen(PORT, () => console.log(`🌐 Servidor HTTP en puerto ${PORT} → /qr para escanear`));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function saveQR(qrData) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await QRCode.toFile(QR_FILE, qrData, { width: 512, margin: 2 });
  console.log(`📷 QR guardado en ${QR_FILE} → abrí /qr en el browser`);
}

function clearQR() {
  try { fs.unlinkSync(QR_FILE); } catch { /* ya no existe */ }
}

function saveGroupJid(jid) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(GROUP_FILE, JSON.stringify({ jid }));
}

function loadGroupJid() {
  try {
    const { jid } = JSON.parse(fs.readFileSync(GROUP_FILE, 'utf8'));
    return jid || null;
  } catch {
    return null;
  }
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, ans => { rl.close(); resolve(ans.trim()); });
  });
}

function buildMessage(a, total, idx) {
  const header = total > 1
    ? `📋 *RESULTADO ANR* (${idx + 1}/${total})`
    : '📋 *RESULTADO ANR*';
  return `${header}
━━━━━━━━━━━━━━━
🪪 CI: ${a.cedula}
👤 Nombre: ${a.nombres} ${a.apellidos}
🎂 Nac.: ${a.nacFormatted}
📍 Dpto: ${a.depNombre}
🏘️ Distrito: ${a.disNombre}
🏠 Seccional: ${a.seccional}
🏫 Local: ${a.locNombre}
🗳️ Mesa: ${a.mesa} | Orden: ${a.orden}
━━━━━━━━━━━━━━━`;
}

// ── Selección de grupo ────────────────────────────────────────────────────────

async function selectGroup(sock) {
  if (process.env.GROUP_JID) {
    console.log(`\n✅ Grupo cargado desde GROUP_JID: ${process.env.GROUP_JID}`);
    return process.env.GROUP_JID;
  }

  const saved = loadGroupJid();
  if (saved) {
    console.log(`\n✅ Grupo cargado desde sesión anterior: ${saved}`);
    return saved;
  }

  await new Promise(r => setTimeout(r, 3000));
  const chats  = await sock.groupFetchAllParticipating();
  const groups = Object.values(chats).map(g => ({ jid: g.id, name: g.subject }));

  if (groups.length === 0) {
    console.log('\n⚠️  No se encontraron grupos.');
    return null;
  }

  console.log('\n📋 GRUPOS DISPONIBLES:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  groups.forEach((g, i) => console.log(`  ${i + 1}. ${g.name}`));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let chosen = null;
  while (!chosen) {
    const ans = await ask('\n¿En qué grupo querés activar el bot? Escribí el número: ');
    const idx = parseInt(ans) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < groups.length) {
      chosen = groups[idx];
    } else {
      console.log(`  ⚠️  Número inválido. Ingresá entre 1 y ${groups.length}.`);
    }
  }

  saveGroupJid(chosen.jid);
  console.log(`\n✅ Bot activado en: "${chosen.name}" | JID: ${chosen.jid}`);
  return chosen.jid;
}

// ── Conexión principal ────────────────────────────────────────────────────────

async function connect() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Bot ANR', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      await saveQR(qr);
    }

    if (connection === 'open') {
      botConnected = true;
      sockRef      = sock;
      clearQR();
      console.log('\n✅ Bot ANR conectado a WhatsApp');
      activeGroupJid = await selectGroup(sock);
      if (activeGroupJid) {
        console.log('\n🟢 Bot escuchando. Filtrando solo el grupo seleccionado.\n');
      }
    }

    if (connection === 'close') {
      botConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log('Reconectando...');
        connect();
      } else {
        console.log('Sesión cerrada. Borrá auth_info y reiniciá.');
      }
    }
  });

  // Debug: loguear cualquier evento de mensajes
  sock.ev.on('messages.update', (updates) => {
    console.log(`📝 messages.update count=${updates.length}`);
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`📨 messages.upsert type=${type} count=${messages.length}`);

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      const hasMsg = !!msg.message;
      const fromMe = msg.key.fromMe;
      console.log(`  → jid=${jid} fromMe=${fromMe} hasMsg=${hasMsg}`);

      if (!hasMsg || fromMe) continue;
      if (activeGroupJid && jid !== activeGroupJid) continue;
      if (!jid?.endsWith('@g.us')) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      const match = text.match(CI_REGEX);
      if (!match) continue;

      const ciRaw = match[1];
      console.log(`🔍 CI detectada: ${ciRaw} | Grupo: ${jid}`);

      const sendWithTimeout = (payload, ms = 15000) =>
        Promise.race([
          sock.sendMessage(jid, payload),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`sendMessage timeout ${ms}ms`)), ms)),
        ]);

      try {
        const resultados = await consultarCI(ciRaw);
        const respuesta  = resultados
          .map((a, i) => buildMessage(a, resultados.length, i))
          .join('\n');
        console.log(`📤 Enviando respuesta para CI ${ciRaw}...`);
        await sendWithTimeout({ text: respuesta });
        console.log(`✅ Respuesta enviada para CI ${ciRaw}`);
      } catch (err) {
        console.error(`❌ Error CI ${ciRaw}: ${err.message}`);
        try {
          await sendWithTimeout({
            text: `❌ CI ${ciRaw.replace(/\./g, '')} no encontrada en el padrón ANR.`,
          });
        } catch (sendErr) {
          console.error(`❌ sendMessage falló: ${sendErr.message}`);
        }
      }
    }
  });
}

connect();
