// services/carSourcing.js
// ---------------------------------------------------------------------------
// Turns a WhatsApp car brief into a scrape.
//
//   Make - Audi                     ->  { make: "Audi", model: "Q2",
//   Model - Q2                           yearFrom: 2022, maxMileage: 60000,
//   Age - 2022 onwards                   instruction: "...", finance: {...} }
//   Mileage - under 60k
//   Colours - Light grey / gun metal grey / Black
//   Auto or manual - Auto
//   Fuel pref - Petrol
//   Spec - with heated seats & reverse camera preferrably
//   Monthly Budget - under £320
//   Deposit - £0
//
// The split matters: only make / model / year / mileage / price are things the
// SITES can filter on. Colour, gearbox, fuel and spec are not filters on either
// source, so they become the ranking instruction, which the deal desk already
// uses to re-weight results. Squeezing them into the search would silently
// return nothing.
//
// The trap this guards against: "Monthly Budget - under £320" is a FINANCE
// figure, not a car price. Mapping it to priceTo would search for £320 cars.
// ---------------------------------------------------------------------------
const Anthropic = require("@anthropic-ai/sdk");
const axios = require("axios");

const apiKey = () => process.env.ANTHROPIC_API_KEY || "";
const model = () => process.env.SOURCING_MODEL || "claude-sonnet-5";

let _client = null;
function client() {
  if (!apiKey()) return null;
  if (!_client) _client = new Anthropic({ apiKey: apiKey() });
  return _client;
}

// ---------------------------------------------------------------------------
// Is this admin message a car brief or a lead submission?
//
// Cheap and deterministic on purpose — an LLM call on every admin message to
// answer a question that "Make -" already answers is a waste of a round trip.
// ---------------------------------------------------------------------------
const BRIEF_KEYS = [
  "make", "model", "age", "year", "mileage", "colour", "color", "colours",
  "auto or manual", "gearbox", "transmission", "fuel", "spec", "budget",
  "monthly", "deposit", "body", "trim",
];

function looksLikeCarBrief(text) {
  if (!text) return false;
  const lines = String(text).split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;

  // "Key - value" or "Key: value" lines whose key is one we recognise.
  let hits = 0;
  for (const line of lines) {
    const m = line.match(/^([A-Za-z][A-Za-z /&]{1,24})\s*[-:–]\s*(.+)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    if (BRIEF_KEYS.some((k) => key === k || key.startsWith(k))) hits++;
  }
  // "Make" or "Model" plus two more recognised fields is a brief, not a lead.
  const hasCore = /^\s*(make|model)\s*[-:–]/im.test(text);
  return hits >= 3 && hasCore;
}

// ---------------------------------------------------------------------------
// Parse the brief with Claude.
// ---------------------------------------------------------------------------
const SYSTEM = `You convert a UK car dealer's free-text sourcing brief into a search for a used-car scraper. Return ONLY valid JSON, no prose, no markdown fences.

Shape:
{
 "make": "",            // manufacturer, e.g. "Audi". "" if not stated.
 "model": "",           // model only, e.g. "Q2" — never the trim or engine.
 "yearFrom": null,      // integer. "2022 onwards"/"2022+" -> 2022. "under 3 years old" -> current year minus 3.
 "maxMileage": null,    // integer miles. "under 60k" -> 60000. "60,000" -> 60000.
 "priceFrom": null,     // integer £, ONLY if a VEHICLE price is stated.
 "priceTo": null,       // integer £, ONLY if a VEHICLE price is stated.
 "postcode": "",        // only if stated in the brief.
 "finance": {
   "monthlyBudget": null,  // integer £ per month, if stated
   "deposit": null,        // integer £, if stated (0 is a real value, not null)
   "term": null            // months, if stated
 },
 "preferences": {
   "colours": [], "gearbox": "", "fuel": "", "spec": [], "other": ""
 },
 "instruction": "",     // ONE sentence for the ranking model, see below
 "confidence": "high"   // high | medium | low
}

Critical rules:
- A MONTHLY budget is finance, never a vehicle price. "Monthly Budget - under £320" sets finance.monthlyBudget = 320 and leaves priceTo null. Getting this wrong searches for £320 cars.
- "Deposit - £0" means deposit = 0. Do not turn 0 into null.
- yearFrom is the EARLIEST acceptable year. "2022 onwards" means cars from 2022 or newer.
- Only put make and model in make/model. Colour, gearbox, fuel, trim and equipment are NOT filters on these sites — put them in preferences and summarise them in "instruction".
- "instruction" is a plain-English priority for a ranking model, e.g. "Prefer automatic petrol cars in light grey, gunmetal grey or black with heated seats and a reverse camera." Write nothing there that is already a hard filter (make, model, year, mileage).
- If a field is not stated, use "" for strings, null for numbers, [] for lists. Never invent values.
- confidence "low" if the message does not read like a car brief at all.`;

async function parseBrief(text) {
  const c = client();
  if (!c) return { ok: false, error: "ANTHROPIC_API_KEY is not set on the WhatsApp service." };

  try {
    const msg = await c.messages.create({
      model: model(),
      max_tokens: 900,
      system: SYSTEM,
      messages: [{ role: "user", content: `Today is ${new Date().toISOString().slice(0, 10)}.\n\nBrief:\n"""\n${text}\n"""` }],
    });
    const raw = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ");
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s === -1 || e === -1) return { ok: false, error: "Could not read a search out of that message." };
    const brief = JSON.parse(raw.slice(s, e + 1));

    if (!brief.make && !brief.model) {
      return { ok: false, error: "No make or model in that message." };
    }
    return { ok: true, brief: normaliseBrief(brief) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Defensive tidy-up. The model is good at this but the scraper takes numbers,
// and a stray "60k" reaching the mileage slider would silently widen the search.
function normaliseBrief(b) {
  const int = (v) => {
    if (v == null || v === "") return null;
    const m = String(v).replace(/[£,\s]/g, "").match(/(\d+(?:\.\d+)?)\s*k?/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return /k$/i.test(String(v).trim()) ? Math.round(n * 1000) : Math.round(n);
  };
  const fin = b.finance || {};
  return {
    make: String(b.make || "").trim(),
    model: String(b.model || "").trim(),
    yearFrom: int(b.yearFrom),
    maxMileage: int(b.maxMileage),
    priceFrom: int(b.priceFrom),
    priceTo: int(b.priceTo),
    postcode: String(b.postcode || "").trim(),
    finance: {
      // 0 is meaningful for deposit, so only null/"" become null.
      monthlyBudget: int(fin.monthlyBudget),
      deposit: fin.deposit === 0 ? 0 : int(fin.deposit),
      term: int(fin.term),
    },
    preferences: {
      colours: Array.isArray(b.preferences?.colours) ? b.preferences.colours : [],
      gearbox: b.preferences?.gearbox || "",
      fuel: b.preferences?.fuel || "",
      spec: Array.isArray(b.preferences?.spec) ? b.preferences.spec : [],
      other: b.preferences?.other || "",
    },
    instruction: String(b.instruction || "").trim(),
    confidence: b.confidence || "medium",
  };
}

// A short human-readable echo, so the sender can see what was understood
// before a two-minute scrape runs on a misread brief.
function summariseBrief(b) {
  const bits = [];
  bits.push(`${b.make} ${b.model}`.trim() || "Any car");
  if (b.yearFrom) bits.push(`${b.yearFrom} onwards`);
  if (b.maxMileage) bits.push(`under ${b.maxMileage.toLocaleString("en-GB")} miles`);
  if (b.priceTo) bits.push(`up to £${b.priceTo.toLocaleString("en-GB")}`);
  const f = b.finance || {};
  if (f.monthlyBudget) bits.push(`£${f.monthlyBudget}/month`);
  if (f.deposit != null) bits.push(`£${f.deposit} deposit`);
  return bits.join(" · ");
}

// ---------------------------------------------------------------------------
// Hand the search to the deal desk.
// ---------------------------------------------------------------------------
const DESK_URL = () => (process.env.CAR_SOURCE_URL || "http://localhost:3000").replace(/\/$/, "");
const DESK_KEY = () => process.env.CAR_SOURCE_API_KEY || "";

async function startScrape(brief, { requestId, callbackUrl, callbackToken }) {
  if (!DESK_KEY()) return { ok: false, error: "CAR_SOURCE_API_KEY is not set on the WhatsApp service." };

  const payload = {
    ref: requestId,
    query: {
      make: brief.make,
      model: brief.model,
      postcode: brief.postcode || process.env.DEFAULT_POSTCODE || "SW1A2AA",
      yearFrom: brief.yearFrom || "",
      maxMileage: brief.maxMileage || "",
      priceFrom: brief.priceFrom || "",
      priceTo: brief.priceTo || "",
    },
    instruction: brief.instruction,
    finance: brief.finance,
    limit: parseInt(process.env.SOURCING_LIMIT || "15", 10),
    callbackUrl,
    callbackToken,
    origin: "whatsapp",
  };

  try {
    const r = await axios.post(`${DESK_URL()}/api/external/search`, payload, {
      headers: { "x-api-key": DESK_KEY(), "Content-Type": "application/json" },
      timeout: 20000,
    });
    return r.data && r.data.ok
      ? { ok: true, chatId: r.data.chatId, jobId: r.data.jobId, dashboardUrl: r.data.dashboardUrl }
      : { ok: false, error: (r.data && r.data.error) || "The deal desk refused the search." };
  } catch (err) {
    const detail = err.response?.data?.error || err.message;
    return { ok: false, error: `Could not reach the deal desk: ${detail}` };
  }
}

module.exports = { looksLikeCarBrief, parseBrief, summariseBrief, startScrape, normaliseBrief, _SYSTEM: SYSTEM };