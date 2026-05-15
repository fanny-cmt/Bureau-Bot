const { App } = require("@slack/bolt");
const Database = require("better-sqlite3");
const Holidays = require("date-holidays");
const path = require("path");

const hd = new Holidays("CA", "QC");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const db = new Database(path.join(__dirname, "data", "bureau.db"));
db.pragma("journal_mode = WAL");

const CHANNEL_IDS = (process.env.SLACK_CHANNEL_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi"];

const PRIVATE_QC_HOLIDAYS = new Set([
  "New Year's Day",
  "National Patriots' Day",
  "National Holiday",
  "Canada Day",
  "Labour Day",
  "Thanksgiving",
  "Christmas Day",
]);

const LONELY_TAGS = [
  "seul·e contre le monde",
  "Robinson du bureau",
  "Highlander : il n'en restera qu'un",
  "Tom Hanks dans Seul au monde",
  "main character du jour",
  "captain solo",
  "the chosen one",
  "dernier·e des Mohicans",
  "boss final",
  "Han Solo, sans Chewbacca",
  "DJ exclusif du open space",
  "président·e du fan club de la machine à café",
];

function pickLonelyTag(week, day) {
  const seed = `${week}-${day}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return LONELY_TAGS[hash % LONELY_TAGS.length];
}

// Init DB
db.exec(`
  CREATE TABLE IF NOT EXISTS presence (
    user_id TEXT,
    week TEXT,
    day TEXT,
    channel TEXT,
    PRIMARY KEY (user_id, week, day, channel)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    week TEXT,
    channel TEXT,
    ts TEXT,
    PRIMARY KEY (week, channel)
  )
`);

// Migration: add channel column / composite PK if tables predate multi-channel support
function migrateSchema() {
  const legacyChannel = process.env.SLACK_CHANNEL_ID || CHANNEL_IDS[0];
  const presenceCols = db.prepare("PRAGMA table_info(presence)").all();
  if (!presenceCols.some((c) => c.name === "channel")) {
    db.exec(`
      ALTER TABLE presence RENAME TO presence_old;
      CREATE TABLE presence (
        user_id TEXT,
        week TEXT,
        day TEXT,
        channel TEXT,
        PRIMARY KEY (user_id, week, day, channel)
      );
      INSERT INTO presence (user_id, week, day, channel)
      SELECT user_id, week, day, '${legacyChannel}' FROM presence_old;
      DROP TABLE presence_old;
    `);
  }

  const messagesCols = db.prepare("PRAGMA table_info(messages)").all();
  const messagesPk = messagesCols.filter((c) => c.pk > 0).map((c) => c.name);
  if (messagesPk.length === 1 && messagesPk[0] === "week") {
    db.exec(`
      ALTER TABLE messages RENAME TO messages_old;
      CREATE TABLE messages (
        week TEXT,
        channel TEXT,
        ts TEXT,
        PRIMARY KEY (week, channel)
      );
      INSERT INTO messages (week, channel, ts)
      SELECT week, channel, ts FROM messages_old;
      DROP TABLE messages_old;
    `);
  }
}
migrateSchema();

function currentWeek() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  return monday.toISOString().split("T")[0];
}

function nextWeek() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const daysUntilNextMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  const monday = new Date(now);
  monday.setDate(now.getDate() + daysUntilNextMonday);
  return monday.toISOString().split("T")[0];
}

function getPresence(week, channel) {
  const rows = db
    .prepare("SELECT user_id, day FROM presence WHERE week = ? AND channel = ?")
    .all(week, channel);
  const result = {};
  DAYS.forEach((d) => (result[d] = []));
  rows.forEach(({ user_id, day }) => result[day].push(user_id));
  return result;
}

function isPublicHoliday(date) {
  const result = hd.isHoliday(date);
  return result && result.some((h) => h.type === "public" && PRIVATE_QC_HOLIDAYS.has(h.name));
}

// Returns a Set of day names (e.g. "Lundi") that are public holidays for the given week
function getHolidaysForWeek(weekMonday) {
  const holidays = new Set();
  const [year, month, day] = weekMonday.split("-").map(Number);
  for (let i = 0; i < 5; i++) {
    const date = new Date(year, month - 1, day + i);
    if (isPublicHoliday(date)) {
      holidays.add(DAYS[i]);
    }
  }
  return holidays;
}

function buildBlocks(week, presence) {
  const holidays = getHolidaysForWeek(week);
  const monday = new Date(week);
  const dateLabel = `Semaine du ${monday.getUTCDate()} ${monday.toLocaleString("fr-FR", { month: "long", timeZone: "UTC" })}`;

  const dayButtons = DAYS.map((day) => {
    const holiday = holidays.has(day);
    const count = presence[day].length;
    return {
      type: "button",
      text: {
        type: "plain_text",
        text: holiday ? `${day} (Férié)` : `${day} (${count})`,
      },
      value: week,
      action_id: `toggle_${day}`,
      style: holiday ? "danger" : count > 0 ? "primary" : undefined,
    };
  });

  const recap = DAYS.map((day) => {
    if (holidays.has(day)) {
      return `*${day}* : _Férié_`;
    }
    const users = presence[day];
    if (users.length === 0) return `*${day}* : —`;
    if (users.length === 1) {
      return `*${day}* : <@${users[0]}> — _${pickLonelyTag(week, day)}_`;
    }
    return `*${day}* : ${users.map((u) => `<@${u}>`).join(", ")}`;
  }).join("\n");

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Qui vient au bureau ?*\n${dateLabel}` },
    },
    { type: "actions", elements: dayButtons },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: recap } },
  ];
}

function buildFrozenBlocks(week) {
  const monday = new Date(week);
  const dateLabel = `Semaine du ${monday.getUTCDate()} ${monday.toLocaleString("fr-FR", { month: "long", timeZone: "UTC" })}`;

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Qui vient au bureau ?*\n${dateLabel} (terminé)` },
    },
  ];
}

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30_000;

async function retryAsync(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.error(`Échec ${label} (tentative ${attempt}/${RETRY_ATTEMPTS}) : ${err.message}`);
      if (attempt < RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr;
}

async function postWeeklyMessage(week) {
  const previous = db.prepare("SELECT channel, ts FROM messages WHERE week != ?").all(week);
  for (const prev of previous) {
    try {
      await app.client.pins.remove({ channel: prev.channel, timestamp: prev.ts });
    } catch (err) {
      console.error(`Échec du désépinglage précédent : ${err.message}`);
    }
  }

  for (const channel of CHANNEL_IDS) {
    try {
      await retryAsync(async () => {
        const presence = getPresence(week, channel);
        const result = await app.client.chat.postMessage({
          channel,
          text: `Présences bureau — semaine du ${week}`,
          blocks: buildBlocks(week, presence),
        });

        db.prepare("INSERT OR REPLACE INTO messages (week, channel, ts) VALUES (?, ?, ?)").run(
          week,
          channel,
          result.ts,
        );

        try {
          await app.client.pins.add({ channel, timestamp: result.ts });
        } catch (err) {
          console.error(`Échec de l'épinglage : ${err.message}`);
        }

        console.log(`Message envoyé pour la semaine du ${week} dans ${channel}`);
      }, `envoi dans ${channel}`);
    } catch (err) {
      console.error(`Abandon envoi dans ${channel} : ${err.message}`);
    }
  }
}

// Handle button clicks
DAYS.forEach((day) => {
  app.action(`toggle_${day}`, async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    const week = body.actions[0].value || nextWeek();
    const channel = body.container.channel_id;

    // Ignore clicks on holiday days
    const holidays = getHolidaysForWeek(week);
    if (holidays.has(day)) return;

    const existing = db
      .prepare("SELECT 1 FROM presence WHERE user_id = ? AND week = ? AND day = ? AND channel = ?")
      .get(userId, week, day, channel);

    if (existing) {
      db.prepare(
        "DELETE FROM presence WHERE user_id = ? AND week = ? AND day = ? AND channel = ?",
      ).run(userId, week, day, channel);
    } else {
      db.prepare(
        "INSERT OR IGNORE INTO presence (user_id, week, day, channel) VALUES (?, ?, ?, ?)",
      ).run(userId, week, day, channel);
    }

    const presence = getPresence(week, channel);
    await client.chat.update({
      channel,
      ts: body.container.message_ts,
      text: `Présences bureau — semaine du ${week}`,
      blocks: buildBlocks(week, presence),
    });
  });
});

// Send message at 9am on the last business day of the week (Friday, or earlier if holidays)
function getNextSendDate() {
  const now = new Date();

  const dayOfWeek = now.getDay();

  // Find next Friday
  const friday = new Date(now);
  const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
  friday.setDate(now.getDate() + daysUntilFriday);
  friday.setHours(9, 0, 0, 0);

  // If we're past that time, jump to next week's Friday
  if (friday <= now) {
    friday.setDate(friday.getDate() + 7);
  }

  // Walk back from Friday to find the last business day (skip holidays and weekends)
  const sendDate = new Date(friday);
  while (isPublicHoliday(sendDate) || sendDate.getDay() === 0 || sendDate.getDay() === 6) {
    sendDate.setDate(sendDate.getDate() - 1);
  }

  if (sendDate < friday) {
    const dayNames = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
    console.log(`Vendredi ${friday.toISOString().split("T")[0]} férié → envoi ${dayNames[sendDate.getDay()]} ${sendDate.toISOString().split("T")[0]}`);
  }

  sendDate.setHours(9, 0, 0, 0);
  return sendDate;
}

// Intended send date for the current calendar week (may be in the past, unlike getNextSendDate)
function getThisWeekSendDate() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  let daysToFriday;
  if (dayOfWeek === 0) daysToFriday = -2; // Dimanche -> vendredi précédent
  else if (dayOfWeek === 6) daysToFriday = -1; // Samedi -> vendredi précédent
  else daysToFriday = 5 - dayOfWeek; // Lun-Ven -> vendredi de cette semaine

  const friday = new Date(now);
  friday.setDate(now.getDate() + daysToFriday);
  friday.setHours(9, 0, 0, 0);

  const sendDate = new Date(friday);
  while (isPublicHoliday(sendDate) || sendDate.getDay() === 0 || sendDate.getDay() === 6) {
    sendDate.setDate(sendDate.getDate() - 1);
  }
  sendDate.setHours(9, 0, 0, 0);
  return sendDate;
}

async function catchUpSendIfNeeded() {
  const thisWeekSendDate = getThisWeekSendDate();
  const now = new Date();
  if (now < thisWeekSendDate) return;

  const targetMonday = new Date(thisWeekSendDate);
  const daysToMonday = ((1 - targetMonday.getDay() + 7) % 7) || 7;
  targetMonday.setDate(targetMonday.getDate() + daysToMonday);
  const targetWeek = targetMonday.toISOString().split("T")[0];

  // Skip if the target cycle has already started — nextWeek() no longer refers to this send
  if (targetWeek !== nextWeek()) return;

  const exists = db.prepare("SELECT 1 FROM messages WHERE week = ? LIMIT 1").get(targetWeek);
  if (exists) return;

  console.log(`Rattrapage : envoi du message pour la semaine du ${targetWeek} (prévu ${thisWeekSendDate.toISOString()})`);
  await postWeeklyMessage(targetWeek);
}

function scheduleNextMessage() {
  const now = new Date();
  const sendDate = getNextSendDate();
  const ms = sendDate - now;
  console.log(`Prochain message prévu : ${sendDate.toISOString()} (dans ${Math.round(ms / 1000 / 60)} min)`);
  setTimeout(async () => {
    try {
      await postWeeklyMessage(nextWeek());
    } catch (err) {
      console.error(`Erreur inattendue lors de l'envoi hebdomadaire : ${err.message}`);
    } finally {
      scheduleNextMessage();
    }
  }, ms);
}

function getNextFreezeDate() {
  const now = new Date();

  const dayOfWeek = now.getDay();

  // Find next Friday
  const friday = new Date(now);
  const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
  friday.setDate(now.getDate() + daysUntilFriday);
  friday.setHours(15, 30, 0, 0);

  // If we're past Friday 15h30, jump to next week
  if (friday <= now) {
    friday.setDate(friday.getDate() + 7);
  }

  // Walk back from Friday if it's a holiday
  const freezeDate = new Date(friday);
  while (isPublicHoliday(freezeDate) || freezeDate.getDay() === 0 || freezeDate.getDay() === 6) {
    freezeDate.setDate(freezeDate.getDate() - 1);
  }

  freezeDate.setHours(15, 30, 0, 0);
  return freezeDate;
}

function scheduleFreezeMessage() {
  const now = new Date();
  const freezeDate = getNextFreezeDate();
  const ms = freezeDate - now;
  console.log(`Gel du message prévu : ${freezeDate.toISOString()} (dans ${Math.round(ms / 1000 / 60)} min)`);
  setTimeout(async () => {
    try {
      await freezeCurrentMessage(app.client);
    } catch (err) {
      console.error(`Erreur inattendue lors du gel : ${err.message}`);
    } finally {
      scheduleFreezeMessage();
    }
  }, ms);
}

async function freezeCurrentMessage(client) {
  const week = currentWeek();
  const messages = db.prepare("SELECT channel, ts FROM messages WHERE week = ?").all(week);
  if (messages.length === 0) return;

  for (const msg of messages) {
    try {
      await retryAsync(async () => {
        await client.chat.update({
          channel: msg.channel,
          ts: msg.ts,
          text: `Présences bureau — semaine du ${week} (terminé)`,
          blocks: buildFrozenBlocks(week),
        });

        try {
          await client.pins.remove({ channel: msg.channel, timestamp: msg.ts });
        } catch (err) {
          console.error(`Échec du désépinglage : ${err.message}`);
        }

        db.prepare("DELETE FROM presence WHERE week = ? AND channel = ?").run(week, msg.channel);
        db.prepare("DELETE FROM messages WHERE week = ? AND channel = ?").run(week, msg.channel);
        console.log(`Message de la semaine du ${week} figé dans ${msg.channel}`);
      }, `gel dans ${msg.channel}`);
    } catch (err) {
      console.error(`Abandon gel dans ${msg.channel} : ${err.message}`);
    }
  }
}

(async () => {
  await app.start();
  console.log("Bureau Bot démarré en Socket Mode");
  try {
    await catchUpSendIfNeeded();
  } catch (err) {
    console.error(`Erreur rattrapage au démarrage : ${err.message}`);
  }
  scheduleNextMessage();
  scheduleFreezeMessage();
})();
