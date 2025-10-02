// server.js
const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const path = require("path");
const fs = require("fs-extra");
const { Parser } = require("json2csv");
const XLSX = require("xlsx");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.json({ limit: "10mb" }));

let qrCodeData = null;
let isAuthenticated = false;
let groupsCache = [];

// initialize WhatsApp client with LocalAuth (persistent session)
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "waextractor", dataPath: "./session" }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  }
});

// -- QR
client.on("qr", async (qr) => {
  try {
    qrCodeData = await qrcode.toDataURL(qr);
    isAuthenticated = false;
    console.log("📲 QR Code received — scan with WhatsApp mobile app.");
  } catch (err) {
    console.error("Failed to generate QR:", err);
  }
});

// -- ready
client.on("ready", async () => {
  console.log("✅ WhatsApp client is ready!");
  isAuthenticated = true;
  await refreshGroups();
});

// -- auth failure
client.on("auth_failure", (msg) => {
  console.error("❌ AUTH FAILURE:", msg);
  isAuthenticated = false;
});

// -- disconnected
client.on("disconnected", (reason) => {
  console.log("⚠️ Client disconnected:", reason);
  isAuthenticated = false;
});

// initialize client
client.initialize();

// ---------- Helpers ----------
async function refreshGroups() {
  try {
    console.log("🔄 Fetching chats...");
    const chats = await client.getChats();
    // robust group detection: chat.isGroup or server g.us
    groupsCache = chats.filter(c => (c.isGroup === true) || (c.id && c.id.server === "g.us"));
    console.log(`📂 Found ${groupsCache.length} groups`);
    // log small sample
    groupsCache.slice(0, 10).forEach(g => console.log(" →", g.id._serialized, g.name));
  } catch (err) {
    console.error("Error fetching chats:", err);
  }
}

// normalize participant id extractor
function getParticipantId(part) {
  if (!part) return null;
  if (typeof part === "string") return part;
  if (part.id && typeof part.id._serialized === "string") return part.id._serialized;
  if (part._serialized && typeof part._serialized === "string") return part._serialized;
  return null;
}

// ---------- Routes ----------

// home / QR
app.get("/", (req, res) => {
  if (!isAuthenticated) {
    res.render("index", { qr: qrCodeData });
  } else {
    res.redirect("/groups");
  }
});

// groups list
app.get("/groups", async (req, res) => {
  if (!isAuthenticated) return res.redirect("/");
  if (!groupsCache || groupsCache.length === 0) await refreshGroups();

  // map groups to simple objects
  const groups = groupsCache.map(g => ({
    id: g.id._serialized,
    name: g.name || "(no name)"
  }));

  res.render("groups", { groups });
});

// debug: raw chats JSON (helpful if troubleshooting)
app.get("/debug-chats", async (req, res) => {
  if (!isAuthenticated) return res.status(403).send("Not authenticated");
  try {
    const chats = await client.getChats();
    const out = chats.map(c => ({
      id: c.id ? c.id._serialized : null,
      name: c.name || null,
      isGroup: c.isGroup || false,
      kind: c.kind || null,
      unreadCount: c.unreadCount || 0
    }));
    res.json({ ok: true, totalChats: chats.length, sample: out.slice(0, 200) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// extract route (selected groups)
app.post("/extract", async (req, res) => {
  if (!isAuthenticated) return res.redirect("/");

  let { selectedGroups } = req.body;
  if (!selectedGroups) return res.redirect("/groups");
  if (!Array.isArray(selectedGroups)) selectedGroups = [selectedGroups];

  const allEntries = []; // unified entries: { groupId, groupName, name, number?, id?, type }

  const perGroupResults = [];

  for (const gid of selectedGroups) {
    try {
      const chat = await client.getChatById(gid);
      const gName = chat?.name || gid;
      console.log(`🔍 Extracting members for ${gName} (${gid})`);

      // collect participant IDs robustly
      let rawParticipants = [];

      // chat.participants could be a Collection, object or array
      if (Array.isArray(chat.participants)) {
        rawParticipants = chat.participants.map(getParticipantId);
      } else if (chat.participants && typeof chat.participants === "object") {
        // If it's a Collection with keys() function
        if (typeof chat.participants.keys === "function") {
          rawParticipants = Array.from(chat.participants.keys());
          // keys may be IDs already; if empty try values
          if (rawParticipants.length === 0) {
            rawParticipants = Array.from(chat.participants.values()).map(getParticipantId);
          }
        } else {
          // object with entries
          rawParticipants = Object.values(chat.participants).map(getParticipantId);
        }
      } else if (chat.groupMetadata && Array.isArray(chat.groupMetadata.participants)) {
        rawParticipants = chat.groupMetadata.participants.map(getParticipantId);
      }

      rawParticipants = rawParticipants.filter(Boolean);
      rawParticipants = [...new Set(rawParticipants)]; // unique

      // fetch contact info in parallel but bounded if very large
      const contactPromises = rawParticipants.map(id => {
        // ensure id is a string
        if (typeof id !== "string") return Promise.resolve({ id: null, name: null, ok: false });
        return client.getContactById(id)
          .then(contact => {
            const name = contact?.pushname || contact?.name || (contact?.number ? contact.number : null) || null;
            return { id, name, ok: true };
          })
          .catch(err => {
            // fallback: no contact (hidden), still return id
            return { id, name: null, ok: false };
          });
      });

      // run promises with allSettled to avoid failure on single error
      const settled = await Promise.allSettled(contactPromises);
      const participantsResolved = settled.map(s => {
        if (s.status === "fulfilled") return s.value;
        return { id: null, name: null, ok: false };
      }).filter(p => p && p.id);

      // build arrays
      const numbers = [];
      const hidden = [];

      for (const p of participantsResolved) {
        const id = p.id;
        const displayName = p.name || null;
        if (id.includes("@c.us")) {
          const cleanNumber = id.replace("@c.us", "");
          numbers.push({ number: cleanNumber, name: displayName || cleanNumber });
          allEntries.push({ groupId: gid, groupName: gName, name: displayName || cleanNumber, number: cleanNumber, id: id, type: "number" });
        } else {
          // @lid or other types
          hidden.push({ id, name: displayName || id });
          allEntries.push({ groupId: gid, groupName: gName, name: displayName || id, id: id, type: "hidden" });
        }
      }

      perGroupResults.push({
        groupId: gid,
        groupName: gName,
        numbers,
        hiddenIds: hidden
      });

      console.log(` → ${numbers.length} phone numbers, ${hidden.length} hidden IDs`);

    } catch (err) {
      console.error("Error extracting for group", gid, err);
      perGroupResults.push({ groupId: gid, groupName: gid, numbers: [], hiddenIds: [], error: String(err) });
    }
  }

  res.render("members", {
    perGroupResults,
    combined: {
      all: allEntries,
      numbers: allEntries.filter(x => x.type === "number"),
      hidden: allEntries.filter(x => x.type === "hidden")
    }
  });
});

// export endpoint (CSV/XLSX/JSON)
function makeExportFilename(prefix, ext) {
  const date = new Date().toISOString().slice(0, 10);
  return `${prefix}-${date}.${ext}`;
}

app.post("/export", async (req, res) => {
  if (!isAuthenticated) return res.status(403).send("Not authenticated");

  // payload may come as JSON string or object
  let payload = req.body.payload;
  if (!payload) return res.status(400).send("No payload");
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch (e) { return res.status(400).send("Invalid payload JSON"); }
  }
  if (!Array.isArray(payload) || payload.length === 0) return res.status(400).send("Payload must be non-empty array");

  const format = (req.body.format || "csv").toLowerCase();

  try {
    const outDir = path.join(__dirname, "exports");
    await fs.ensureDir(outDir);

    if (format === "csv") {
      const fields = ["groupName", "groupId", "name", "number", "id", "type"];
      const parser = new Parser({ fields, flatten: true });
      const csv = parser.parse(payload);
      const fname = makeExportFilename("whatsapp-export", "csv");
      const full = path.join(outDir, fname);
      await fs.writeFile(full, csv, "utf8");
      return res.download(full, fname);
    }

    if (format === "xlsx") {
      // ensure consistent columns for Excel
      const ws = XLSX.utils.json_to_sheet(payload);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Export");
      const fname = makeExportFilename("whatsapp-export", "xlsx");
      const full = path.join(outDir, fname);
      XLSX.writeFile(wb, full);
      return res.download(full, fname);
    }

    if (format === "json") {
      const fname = makeExportFilename("whatsapp-export", "json");
      const full = path.join(outDir, fname);
      await fs.writeFile(full, JSON.stringify(payload, null, 2), "utf8");
      return res.download(full, fname);
    }

    return res.status(400).send("Unsupported format");
  } catch (err) {
    console.error("Export error:", err);
    return res.status(500).send("Export failed");
  }
});

// refresh groups route
app.get("/refresh-groups", async (req, res) => {
  if (!isAuthenticated) return res.redirect("/");
  await refreshGroups();
  res.redirect("/groups");
});

// status route
app.get("/status", (req, res) => {
  res.json({ authenticated: isAuthenticated, groups: groupsCache.length });
});

// start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
