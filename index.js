const express = require("express");
const qrcode = require("qrcode");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  WAMessage,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const fs = require("fs");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

let sock;
let qrData = null; // Menyimpan QR code dalam format base64
let isConnected = false; // Menandakan apakah sudah terhubung atau belum

// Fungsi untuk memulai socket WhatsApp
async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: state.keys },
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrData = await qrcode.toDataURL(qr);
      console.log("QR Code diterima");
      isConnected = false;
      sendConnectionStatus(); // Kirim status koneksi
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom &&
        lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log("Koneksi terputus, mencoba reconnect...");
        startSocket();
      }
    } else if (connection === "open") {
      console.log("WhatsApp terhubung");
      qrData = null;
      isConnected = true;
      sendConnectionStatus(); // Kirim status koneksi
    }
  });
}

// Menampilkan QR Code atau tampilan "WhatsApp Connected"
app.get("/qr", (req, res) => {
  if (isConnected) {
    return res.send(`
            <html>
                <body style="text-align: center; font-family: sans-serif;">
                    <h2>WhatsApp Terhubung!</h2>
                    <p>WhatsApp telah berhasil terhubung. Sekarang Anda dapat mengirim pesan.
                    Rest API : [host]/send-message Test : curl -X POST https://wapi.dafamsemarang.my.id/send-message \
                                -H "Content-Type: application/json" \
                                -d '{"phoneNumber": "628567868154", "message": "Halo, ini pesan dari WhatsApp Gateway!"}'
                    </p>
                    <script>
                        // Mendengarkan perubahan status koneksi secara real-time
                        const eventSource = new EventSource('/status');
                        eventSource.onmessage = function(event) {
                            if (event.data === 'connected') {
                                document.body.innerHTML = "<h2>WhatsApp Terhubung!</h2><p>WhatsApp telah berhasil terhubung. Sekarang Anda dapat mengirim pesan.
                                Rest API : [host]/send-message Test : curl -X POST https://wapi.dafamsemarang.my.id/send-message \
                                -H "Content-Type: application/json" \
                                -d '{"phoneNumber": "628567868154", "message": "Halo, ini pesan dari WhatsApp Gateway!"}'
                                </p>";
                            } else {
                                document.body.innerHTML = "<h2>QR Code Belum Terhubung</h2>";
                            }
                        };
                    </script>
                </body>
            </html>
        `);
  }

  if (!qrData) {
    return res.send("<h2>Tidak ada QR saat ini. Mungkin sudah terhubung.</h2>");
  }

  res.send(`
        <html>
            <body style="text-align: center; font-family: sans-serif;">
                <h2>Scan QR WhatsApp</h2>
                <img src="${qrData}" />
                <p>Scan dengan WhatsApp pada perangkat kamu</p>
            </body>
        </html>
    `);
});

// Endpoint untuk mengirim pesan
app.post("/send-message", async (req, res) => {
  let { phoneNumber, message } = req.body;

  if (!phoneNumber || !message) {
    return res.status(400).send("Nomor telepon dan pesan harus diisi");
  }

  // Format nomor telepon jika diawali dengan 0
  phoneNumber = formatPhoneNumber(phoneNumber);

  try {
    const jid = `${phoneNumber}@s.whatsapp.net`; // Format nomor WhatsApp
    const sendMessage = await sock.sendMessage(jid, { text: message });
    console.log(`Pesan berhasil dikirim ke ${phoneNumber}`);
    res.send({
      status: "success",
      message: "Pesan berhasil dikirim",
      data: sendMessage,
    });
  } catch (error) {
    console.error("Gagal mengirim pesan:", error);
    res.status(500).send("Gagal mengirim pesan");
  }
});

app.post("/send-message-group", async (req, res) => {
  let { groupId, message } = req.body;

  if (!groupId || !message) {
    return res.status(400).send("Group ID dan pesan harus diisi");
  }

  try {
    const jid = groupId.endsWith("@g.us") ? groupId : groupId + "@g.us";
    const sendMessage = await sock.sendMessage(jid, { text: message });
    console.log(`Pesan berhasil dikirim ke ${jid}`);
    res.send({
      status: "success",
      message: "Pesan berhasil dikirim",
      data: sendMessage,
    });
  } catch (error) {
    console.error("Gagal mengirim pesan:", error);
    res.status(500).send("Gagal mengirim pesan");
  }
});

// Fungsi untuk memformat nomor telepon
function formatPhoneNumber(phoneNumber) {
  if (phoneNumber.startsWith("0")) {
    return "62" + phoneNumber.slice(1); // Ganti 0 dengan kode negara Indonesia (62)
  }
  return phoneNumber;
}

// Menangani login menggunakan pairing code
app.post("/pairing", async (req, res) => {
  const phoneNumber = req.body.phoneNumber; // Nomor telepon dalam format E.164
  if (!phoneNumber) {
    return res.status(400).send("Nomor telepon harus diisi");
  }

  try {
    const code = await sock.requestPairingCode(phoneNumber);
    console.log(`Pairing code: ${code}`);
    res.send({ code });
  } catch (error) {
    res.status(500).send("Gagal meminta pairing code");
  }
});

app.get("/", (req, res) => {
  res.send(`
        <html>
            <body style="text-align: center; font-family: sans-serif;">
                <h1>Welcome to WhatsApp API</h1>
                <p>Gunakan <a href="/qr">QR</a> atau Pairing Code untuk memulai</p>
            </body>
        </html>
    `);
});

// Fitur SSE untuk mengirimkan status koneksi secara real-time
function sendConnectionStatus() {
  app.get("/status", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");

    // Kirimkan status koneksi (terhubung atau tidak)
    res.write(`data: ${isConnected ? "connected" : "disconnected"}\n\n`);
  });
}

// =============================================
// Endpoint lihat daftar group
// =============================================
app.get("/list-groups", async (req, res) => {
  try {
    if (!sock || !isConnected) {
      return res.status(400).send("WhatsApp belum terhubung");
    }

    // Mengambil semua grup yang diikuti oleh nomor yang terhubung
    const groups = await sock.groupFetchAllParticipating();
    
    const groupList = Object.values(groups).map((group) => ({
      id: group.id,
      name: group.subject || "Tanpa Nama",
      participants: group.participants?.length || 0,
      createdAt: group.creation || "Tidak diketahui",
      description: group.desc || "Tidak ada deskripsi",
      isAdmin: group.participants.find(p => p.id === sock.user.id)?.admin === "admin"
    }));

    res.send({
      status: "success",
      data: groupList,
    });
  } catch (error) {
    console.error("Gagal mengambil daftar group:", error);
    res.status(500).send("Gagal mengambil daftar group");
  }
});

// Memulai socket WhatsApp
startSocket();

// Menjalankan server Express
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});
