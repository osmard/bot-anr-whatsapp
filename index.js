import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import QRCode from 'qrcode';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { consultarCI } from './scraper.js';

const AUTH_DIR   = process.env.AUTH_DIR || '/app/auth_info';
const GROUP_FILE = path.join(AUTH_DIR, 'selected_group.json');
const QR_FILE    = path.join(AUTH_DIR, 'qr.png');
const PORT       = process.env.PORT || 3000;
const CI_REGEX   = /\bci[:\s]*([0-9][.0-9]*[0-9]+)/i;

let activeGroupId = process.env.GROUP_JID || loadGroupJid();
let botConnected  = false;
let clientRef     = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function clearQR() {
  try { fs.unlinkSync(QR_FILE); } catch { /* ya no existe */ }
}

async function saveQR(qrData) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await QRCode.toFile(QR_FILE, qrData, { width: 512, margin: 2 });
  console.log(`📷 QR guardado → abrí /qr en el browser`);
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
  res.json({ connected: botConnected, group: activeGroupId });
});

app.get('/groups', async (req, res) => {
  if (!botConnected || !clientRef) return res.status(503).json({ error: 'Bot no conectado aún' });
  try {
    const chats  = await clientRef.getChats();
    const groups = chats
      .filter(c => c.isGroup)
      .map(g => ({ id: g.id._serialized, name: g.name }));
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/group-info', async (req, res) => {
  if (!botConnected || !clientRef || !activeGroupId) return res.status(503).json({ error: 'Bot no conectado o sin grupo' });
  try {
    const chat = await clientRef.getChatById(activeGroupId);
    res.json({ name: chat.name, id: chat.id._serialized, participants: chat.participants?.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/activate', async (req, res) => {
  if (!botConnected || !clientRef) return res.status(503).json({ error: 'Bot no conectado aún' });
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'Parámetro ?name= requerido' });
  try {
    const chats  = await clientRef.getChats();
    const groups = chats.filter(c => c.isGroup).map(g => ({ id: g.id._serialized, name: g.name }));
    const match  =
      groups.find(g => g.name === name) ||
      groups.find(g => g.name.toLowerCase().includes(name.toLowerCase()));
    if (!match) return res.status(404).json({ error: `Grupo "${name}" no encontrado`, grupos_disponibles: groups.map(g => g.name) });
    activeGroupId = match.id;
    saveGroupJid(match.id);
    console.log(`✅ Grupo activado vía HTTP: "${match.name}" | ${match.id}`);
    res.json({ ok: true, grupo: match.name, id: match.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/send-test', async (req, res) => {
  if (!botConnected || !clientRef) return res.status(503).json({ error: 'Bot no conectado' });
  if (!activeGroupId) return res.status(400).json({ error: 'Ningún grupo activo' });
  const texto = req.query.msg || '✅ Test de envío OK';
  try {
    const chat = await clientRef.getChatById(activeGroupId);
    await chat.sendMessage(texto);
    res.json({ ok: true, enviado: texto });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/send-direct', async (req, res) => {
  if (!botConnected || !clientRef) return res.status(503).json({ error: 'Bot no conectado' });
  const to  = req.query.to;
  const msg = req.query.msg || 'Test bot ANR';
  if (!to) return res.status(400).json({ error: 'Parámetro ?to= requerido' });
  try {
    await clientRef.sendMessage(to, msg);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/reset-session', async (req, res) => {
  try {
    if (clientRef) {
      try { await clientRef.destroy(); } catch { /* ignorar */ }
    }
    botConnected = false;
    clientRef    = null;

    const files   = fs.readdirSync(AUTH_DIR);
    const deleted = [];
    for (const f of files) {
      if (f === 'selected_group.json') continue;
      const full = path.join(AUTH_DIR, f);
      if (fs.statSync(full).isDirectory()) {
        // borrar recursivo solo si es carpeta de sesión wwebjs
        if (f.startsWith('wwebjs_auth') || f.startsWith('session')) {
          fs.rmSync(full, { recursive: true, force: true });
          deleted.push(f);
        }
        continue;
      }
      fs.unlinkSync(full);
      deleted.push(f);
    }
    res.json({ ok: true, deleted, msg: 'Sesión limpiada. Refrescá /qr.' });
    setTimeout(() => startClient(), 1500);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🌐 HTTP en puerto ${PORT} → /qr para escanear`));

// ── Cliente whatsapp-web.js ───────────────────────────────────────────────────

function startClient() {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
      ],
    },
  });

  client.on('qr', async (qr) => {
    await saveQR(qr);
  });

  client.on('ready', async () => {
    botConnected = true;
    clientRef    = client;
    clearQR();
    console.log('\n✅ Bot ANR conectado a WhatsApp');

    // Cargar grupo guardado o buscar por nombre
    if (!activeGroupId) {
      const saved = loadGroupJid();
      if (saved) {
        activeGroupId = saved;
        console.log(`✅ Grupo cargado desde sesión anterior: ${saved}`);
      } else {
        await autoActivateGroup(client);
      }
    } else {
      console.log(`✅ Grupo activo: ${activeGroupId}`);
    }

    console.log('\n🟢 Bot escuchando mensajes.\n');
  });

  client.on('disconnected', (reason) => {
    console.log(`⚠️ Desconectado: ${reason}`);
    botConnected = false;
    clientRef    = null;
    // Reintentar después de 5s
    setTimeout(() => startClient(), 5000);
  });

  client.on('auth_failure', (msg) => {
    console.error(`❌ Auth failure: ${msg}`);
    botConnected = false;
    clientRef    = null;
  });

  const handleMessage = async (msg) => {
    const chatId = msg.from;
    console.log(`📨 msg: chatId=${chatId} fromMe=${msg.fromMe} body="${(msg.body||'').substring(0,80)}"`);

    if (msg.fromMe) return;
    if (!chatId.endsWith('@g.us')) return;
    if (activeGroupId && chatId !== activeGroupId) {
      console.log(`  ↳ ignorado (grupo distinto: ${chatId} != ${activeGroupId})`);
      return;
    }

    const text = msg.body || '';
    const match = text.match(CI_REGEX);
    if (!match) return;

    const ciRaw = match[1];
    console.log(`🔍 CI detectada: ${ciRaw} | Grupo: ${chatId}`);

    const send = async (text) => {
      try {
        await msg.reply(text);
      } catch {
        await clientRef.sendMessage(chatId, text);
      }
    };

    try {
      const resultados = await consultarCI(ciRaw);
      const respuesta  = resultados
        .map((a, i) => buildMessage(a, resultados.length, i))
        .join('\n');
      console.log(`📤 Enviando respuesta para CI ${ciRaw}...`);
      await send(respuesta);
      console.log(`✅ Respuesta enviada para CI ${ciRaw}`);
    } catch (err) {
      console.error(`❌ Error CI ${ciRaw}: ${err.message}`);
      await send(`❌ CI ${ciRaw.replace(/\./g, '')} no encontrada en el padrón ANR.`).catch(e =>
        console.error(`❌ send falló: ${e.message}`)
      );
    }
  };

  client.on('message', handleMessage);

  client.initialize().catch(err => {
    console.error(`❌ initialize error: ${err.message}`);
    setTimeout(() => startClient(), 10000);
  });
}

async function autoActivateGroup(client) {
  try {
    await new Promise(r => setTimeout(r, 3000));
    const chats  = await client.getChats();
    const groups = chats.filter(c => c.isGroup).map(g => ({ id: g.id._serialized, name: g.name }));

    if (groups.length === 0) {
      console.log('⚠️ No se encontraron grupos.');
      return;
    }

    // Intentar activar "LISTA 2P opcion 3" automáticamente
    const target = groups.find(g => g.name.toLowerCase().includes('lista 2p'));
    if (target) {
      activeGroupId = target.id;
      saveGroupJid(target.id);
      console.log(`✅ Grupo auto-activado: "${target.name}" | ${target.id}`);
      return;
    }

    console.log('\n📋 GRUPOS DISPONIBLES:');
    groups.forEach((g, i) => console.log(`  ${i + 1}. ${g.name}`));
    console.log('\nUsá /activate?name=<nombre> para activar un grupo.');
  } catch (err) {
    console.error(`❌ autoActivateGroup: ${err.message}`);
  }
}

startClient();
