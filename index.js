import pkg from '@whiskeysockets/baileys';
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = pkg;
import qrcode from 'qrcode-terminal';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { consultarCI } from './scraper.js';

const AUTH_DIR      = process.env.AUTH_DIR || '/app/auth_info';
const GROUP_FILE    = path.join(AUTH_DIR, 'selected_group.json');
const CI_REGEX      = /\bci[:\s]*([0-9][.0-9]*[0-9]+)/i;

// JID activo — se resuelve al conectar
let activeGroupJid  = process.env.GROUP_JID || null;

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
  // 1) Variable de entorno tiene prioridad absoluta
  if (process.env.GROUP_JID) {
    console.log(`\n✅ Grupo cargado desde GROUP_JID: ${process.env.GROUP_JID}`);
    return process.env.GROUP_JID;
  }

  // 2) Sesión previa guardada en volumen
  const saved = loadGroupJid();
  if (saved) {
    console.log(`\n✅ Grupo cargado desde sesión anterior: ${saved}`);
    return saved;
  }

  // 3) Listar grupos y preguntar al usuario
  await new Promise(r => setTimeout(r, 3000)); // esperar sync inicial de chats
  const chats = await sock.groupFetchAllParticipating();
  const groups = Object.values(chats).map(g => ({ jid: g.id, name: g.subject }));

  if (groups.length === 0) {
    console.log('\n⚠️  No se encontraron grupos. Asegurate de que el número esté en al menos un grupo.');
    console.log('    Podés reiniciar o setear GROUP_JID manualmente.');
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
  console.log(`\n✅ Bot activado en: "${chosen.name}"`);
  console.log(`   JID guardado: ${chosen.jid}`);
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
      console.log('\n📱 Escaneá este QR con WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('\n✅ Bot ANR conectado a WhatsApp');
      activeGroupJid = await selectGroup(sock);
      if (activeGroupJid) {
        console.log('\n🟢 Bot escuchando. Filtrando solo el grupo seleccionado.\n');
      }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log('Reconectando...');
        connect();
      } else {
        console.log('Sesión cerrada. Borrá auth_info y reiniciá.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;

      // Filtrar por grupo activo (si ya fue seleccionado)
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

      try {
        const resultados = await consultarCI(ciRaw);
        const respuesta  = resultados
          .map((a, i) => buildMessage(a, resultados.length, i))
          .join('\n');
        await sock.sendMessage(jid, { text: respuesta });
      } catch (err) {
        console.error(`❌ Error CI ${ciRaw}:`, err.message);
        await sock.sendMessage(jid, {
          text: `❌ CI ${ciRaw.replace(/\./g, '')} no encontrada en el padrón ANR.`,
        });
      }
    }
  });
}

connect();
