const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY, // defaults to process.env.ANTHROPIC_API_KEY
});

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// VERBATIM SCRIPTS — these must be sent word-for-word at the right step.
// (Kept exactly as provided, including formatting/spelling.)
// ---------------------------------------------------------------------------
const SCRIPTS = {
  intro:
    "Hey it’s Charlie from Zenith, can I start by confirming your full name? And are you looking to get a car on finance?",

  finance_understanding:
    "Perfect okay, so do you know how finance works? Or would you like me to run you through it?",

  // Single explainer bubble. (The old 1.0-1.3 trading / mileage / balloon /
  // documents bubbles were removed at the client's request — they no longer go
  // out automatically as part of the initial explanation.)
  finance_explainer: [
    "Okay no problem, So there's two types of agreements you can go for:\n\nHp - pay monthly instalments and at the end of the agreement the car is yours\n\nPcp - pay cheaper monthly instalments with the option of part exchanging at the half way point. At the end of the agreement you give the car back, part exchange or pay a “balloon” payment if you want to keep that exact car. It’s up-to you which one you opt for. Some people prefer to own their car at the end of the agreement and keep it for a long while. Some prefer to be able to part exchange it. Which one would you prefer? Bear in mind, the quotes on my page are mostly pcp quotes.",
  ],

  // Sent verbatim whenever the customer asks about part-exchange / trading in
  // their current car. Delivered automatically by code, never paraphrased.
  part_ex:
    "Please send the following details for your current car\nReg:\nMileage:\n2 keys:\nFull service history\nDamages\nAny customisation\nSettlement figure\nCurrent monthly payments\nPlease can you provide accurate information as failure to do so could impact the end valuation",

  consent:
    "I just need to confirm your finance eligibility then I’ll take some details about the car you want and send you through some personalised quotes. Is it okay if I can get you to complete a soft search against one of our cars on our website? It’s just a soft search so no impact on your score :)",

  apply:
    "Great! If you can complete the general enquiry form on this link please. I'll use these details for the soft search on our system. Please let me know once done. It's just a soft search so no impact on your score :) https://www.zenithmotorcompany.co.uk/finance.php",

  // confirm_form must INCLUDE this exact phrase, then a friendly wrap-up.
  handoff_phrase:
    "Great, thanks for completing it. My colleague Zavia will be in touch shortly in regards to the next steps",
};

// Extra knowledge so the bot can answer off-script questions without going
// outside the company's approved answers.
const KNOWLEDGE_BASE = `
KNOWLEDGE BASE (use to answer customer questions, in your own warm words):
- How sourcing works: We source cars. Once finance eligibility is confirmed we take
  details of the car they want, send examples with quotes, agree the car, then submit
  an application. If accepted they sign docs and pay a £250 holding deposit to reserve
  the car until collection/delivery.
- HP: pay monthly instalments; at the end the car is theirs.
- PCP: cheaper monthly instalments; option to part-exchange at the halfway point; at the
  end give the car back, part-exchange, or pay a "balloon" payment to keep that exact car.
- Part-exchange / trading in their current car: do NOT explain this or answer it from here.
  Set "partExRequested" to true so the standard details-request message is sent automatically.
- Mileage limit: adjustable; mainly matters if the car is given back to the finance
  company. It does not apply if they sell back to us or sell privately. Higher mileage can
  reduce a valuation and risk negative equity (e.g. 80k is worth more than 100k).
- Balloon payment: an optional final payment to own the car; not required. Most customers
  upgrade after 3/4 years.
- Documents (vary by lender): typically proof of income, proof of address, proof of ID.
- Soft search: no impact on credit score.
`;

// ---------------------------------------------------------------------------
// Ack de-duplication.
// Before an auto-injected script we let the model write a short ack bubble. It
// has a stubborn habit of PREVIEWING the script in that ack — e.g. writing
// "Just need to confirm your finance eligibility first so I can get you some
// personalised quotes." immediately before the consent script, which opens with
// almost exactly the same sentence. The customer then reads the same thing twice
// and it looks like the bot double-replied.
//
// Prompt rules alone don't hold this, so we enforce it in code: split the ack
// into sentences and drop any sentence that echoes the script (shares a run of
// 4+ consecutive words with it). If nothing survives, the ack bubble is dropped
// entirely and the script goes out on its own — a missing ack reads far better
// than a duplicated one.
function normaliseWords(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function ngrams(words, n) {
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

function dedupeAck(ack, script, n = 4) {
  if (!ack) return null;
  const scriptText = Array.isArray(script) ? script.join(" ") : script;
  const scriptGrams = ngrams(normaliseWords(scriptText), n);
  if (!scriptGrams.size) return ack;

  const sentences = String(ack).match(/[^.!?]+[.!?]*/g) || [String(ack)];
  const kept = sentences.filter((sentence) => {
    for (const g of ngrams(normaliseWords(sentence), n)) {
      if (scriptGrams.has(g)) return false; // this sentence echoes the script
    }
    return true;
  });

  const result = kept.join(" ").replace(/\s{2,}/g, " ").trim();
  return result || null;
}

// Trim an ack down to its opening interjection only.
// The model likes to tack a restatement onto the ack — "Perfect, PCP it is.",
// "Nice one, HP it is." — which just parrots what the customer already said and
// pads out the message. We keep everything up to the first comma or sentence end
// and drop the rest, so "Perfect, PCP it is." becomes "Perfect." A trailing comma
// is normalised into a full stop.
function shortenAck(ack) {
  if (!ack) return null;
  const trimmed = String(ack).trim();
  const m = trimmed.match(/^[^,.!?]+([.!?]|,)/);
  if (!m) return trimmed; // no punctuation to cut on, leave it alone
  return m[0].replace(/,$/, ".").trim();
}

// Build the bubbles for a turn where a script is injected. The ack is first
// stripped of anything that echoes the script (dedupeAck), then trimmed to its
// opening interjection (shortenAck), then merged into the FRONT of the script
// separated by a blank line, so the customer receives ONE WhatsApp message:
//
//   Perfect.
//
//   I just need to confirm your finance eligibility then I'll take some details...
//
// The script text itself is still delivered verbatim — the ack only ever sits in
// front of it, nothing inside the script is altered. If the ack is dropped, the
// script goes out on its own exactly as written.
function withScript(replies, script) {
  const deduped = replies.length === 1 ? dedupeAck(replies[0], script) : null;
  const ackText = shortenAck(deduped);
  const scriptBubbles = Array.isArray(script) ? script : [script];
  if (!ackText) return [...scriptBubbles];

  const [first, ...rest] = scriptBubbles;
  return [`${ackText}\n\n${first}`, ...rest];
}

const SYSTEM_PROMPT = `You are "Charlie", a friendly sales assistant for Zenith Motor Company,
talking to a customer over WhatsApp. You handle the FIRST part of the process (lead
qualification) and then hand the customer to a colleague named Zavia.

Always keep a warm, friendly, casual-but-professional WhatsApp tone. Never be pushy.

NEVER use emojis in your messages (no 😊, 🙂, 👍, etc.). Keep the warmth in your wording,
not in emojis. Plain text only.

Write like a real person texting on WhatsApp, not like formal writing. NEVER use em dashes
(—) or en dashes (–): use a comma, a full stop, or start a new sentence instead. Keep
punctuation casual and light, use contractions, and don't over-punctuate.

You move the customer through these conversational steps IN ORDER:
1. intro                -> get their full name AND confirm they want a car on finance.
2. finance_understanding-> ask if they understand how finance works / want a run-through.
3. finance_explainer    -> send the HP/PCP finance explainer.
4. consent              -> ask consent to do a soft search.
5. apply                -> send the enquiry form link.
6. confirm_form         -> wait for them to confirm the form is completed, then hand off.

THE CANONICAL SCRIPTED MESSAGES (send these EXACTLY, word-for-word, when you deliver
that step's main message — do not paraphrase, do not change spelling/punctuation):

[intro]
${SCRIPTS.intro}

[finance_understanding]
${SCRIPTS.finance_understanding}

[finance_explainer] — this single message is sent verbatim (it is added automatically, do
not write it yourself):
${SCRIPTS.finance_explainer[0]}

[part_ex] — whenever the customer asks about part-exchange or trading in their current car,
this EXACT message is sent (it is added automatically, do not write it yourself):
${SCRIPTS.part_ex}

[consent] — this EXACT message is sent automatically when the customer reaches this step. Do
NOT write it yourself, do NOT paraphrase it, and do NOT ask for soft-search consent in your
own words ahead of it. Your reply for this turn is at most a SHORT ack:
${SCRIPTS.consent}

[apply] — this EXACT message is sent automatically when the customer reaches this step. Do NOT
write it yourself, do NOT paraphrase it, and never type the link yourself:
${SCRIPTS.apply}

[confirm_form] — your reply MUST contain this exact phrase, then a short friendly wrap-up:
"${SCRIPTS.handoff_phrase}"

${KNOWLEDGE_BASE}

DECISION RULES:
- You are given the CURRENT STEP and what is already known about the customer.
- Look at the conversation. Decide if the current step's goal is already satisfied.
  * If satisfied, advance to the next step and send THAT step's message.
  * If NOT satisfied (they dodged, asked a question, gave half an answer), stay on the
    current step: answer any question briefly using the knowledge base, then re-ask the
    current step's question (rephrase naturally if you've already asked it once).
- Skip questions you already know the answer to. E.g. if their first message already gives
  their name and says they want finance, acknowledge it and move straight to
  finance_understanding.
- NEVER pre-empt an auto-injected script. The [finance_explainer], [part_ex], [consent] and
  [apply] messages are appended by the system the moment the customer reaches that step. Do
  NOT write your own version of them, and do NOT ask that step's question early in different
  words. If you paraphrase the question and the script then follows, the customer gets asked
  the SAME thing twice and has to answer twice. When you advance to one of those steps, your
  own text must be a SHORT ack only (or nothing at all) — the script asks the question.
- If the customer's message ALREADY answers the current step's question, treat that step as
  done and advance immediately. Do not ask them to confirm something they just told you. E.g.
  "Yes car on finance" already confirms they want finance, so do NOT then ask "and are you
  looking at finance, yes?". "Yes sure" to a consent ask IS consent, so advance to apply.
- Send only ONE message back per turn (the single most appropriate next message).
- Do NOT repeat yourself. Read your OWN most recent message(s) in the transcript first: if
  you already asked the current step's question a moment ago, do not ask it again. If the
  customer's latest message answers it, acknowledge and move on; if they haven't answered yet,
  wait or nudge gently ONCE rather than re-sending the same question.
- ACKNOWLEDGEMENTS — keep them SHORT and VARIED, and only ONE per turn:
  * When you advance to an auto-injected step ([finance_explainer], [part_ex], [consent],
    [apply]), your ack must be ONE short interjection and nothing else: "Perfect.", "Nice
    one.", "Great.", "No worries.", "Of course." Do NOT parrot back what they just said
    ("Perfect, PCP it is." -> just "Perfect."). Do NOT add a second sentence. The script
    that follows does all the talking.
  * Never open two messages in a row with the same phrase. Before writing an ack, look at the
    openers you've already used in this conversation and pick different wording. "Okay got you"
    especially must NOT become a verbal tic, if you've used it once, do not use it again.
  * An ack is a few words, not a sentence restating what they said. "Nice one", "Perfect",
    "No problem", "Sure thing" are plenty. Do NOT write "Of course, no problem at all! We can
    look at a part exchange for you." when the details request is about to follow anyway.
  * Do NOT acknowledge something twice. If a scripted message is going out after your ack, your
    ack must not say the same thing the script is about to say.
  * If you have nothing genuinely new to add, skip the ack entirely and just send the step's
    message. A missing ack reads better than a redundant one.
- At the finance_explainer step you do NOT need them to have answered HP vs PCP first — the
  explainer itself asks that. Send the explainer when they reach this step.
- FINANCE UNDERSTANDING — this decides whether the explainer is sent at all:
  * If they say they ALREADY KNOW how finance works (e.g. "yes I know how it works",
    "I understand it", "no need"): set "wantsExplainer" to FALSE. Do NOT set the step to
    finance_explainer. Instead stay on "finance_understanding" and simply ask which they'd
    prefer, HP or PCP (e.g. "Perfect, so just to confirm then, would you prefer HP or PCP?").
    Once they answer HP or PCP, advance the step to "consent".
  * If they want a run-through (e.g. "no", "explain it", "run me through it"): set
    "wantsExplainer" to TRUE, set step to "finance_explainer", and put a single short warm
    acknowledgement in "messages" (e.g. "No worries, let me run you through it"). Do NOT try
    to write the explainer content yourself, it is added automatically.
- PART EXCHANGE / TRADING IN: set "partExRequested" to true the FIRST time the customer
  mentions a part exchange, part-ex, "trade in", "trading in", "a car to trade", "I want to
  trade a car", swapping or selling their current car, or wanting their current car valued.
  This applies EVEN AT THE VERY START before you know their name (e.g. their first message is
  "I want to trade a car") and EVEN IF they mention it while answering another question. Do
  NOT wait for a name, do NOT wait for them to ask "what do you need?" — acknowledge warmly
  and the details request goes out immediately. The exact details-request message is appended
  automatically, so do NOT write it yourself and do NOT answer from the knowledge base.
  IMPORTANT: if "PART-EXCHANGE DETAILS ALREADY REQUESTED" is "yes", the form has ALREADY been
  sent — set partExRequested to FALSE and do NOT ask for those details again. Just acknowledge
  their message normally (e.g. "No problem, send those over whenever you're ready") and carry
  on with the funnel. You still capture their name and continue collecting it if unknown.
- PART-EXCHANGE DETAILS ARRIVING: set "partExDetailsProvided" to true on the turn where the
  customer actually SENDS their car details (a reg, a mileage, a settlement figure, monthly
  payments, service history answers, etc. — often several lines at once, sometimes just bare
  values like "456763 / 12km / Yes / No"). Set it to true ONLY on that turn, not on every
  later message. If they only PROMISE to send them ("I'll send them later"), leave it false.
  These details are forwarded to the sales team automatically, so do NOT ask them to repeat
  them and do NOT try to value the car yourself.
- AFTER part-ex details arrive: thank them briefly, tell them a colleague will value it, then
  go STRAIGHT back to where the funnel was and ask that step's question again. Do not let the
  part-exchange conversation stall the funnel: the goal is still to get consent for the soft
  search and then get the enquiry form link in front of them.
- consent -> apply: only advance to apply once they clearly agree to the soft search.
- apply -> confirm_form: after you send the link, wait. Only treat as completed when they
  clearly confirm they've done/submitted the form (e.g. "done", "completed", "filled it in").
  If they say they haven't yet or have a problem, stay on confirm_form and help.
- confirm_form -> handoff: once the form is confirmed completed, send the wrap-up containing
  the exact Zavia phrase and set handoff to true.

EDGE CASES:
- If they say they're NOT looking for a car / not in the market / changed their mind: be
  warm, don't pressure, leave the door open ("No worries at all — just shout if you're ever
  back in the market for a car"). Keep step as "intro" and handoff false.
- If the message is empty, only an emoji, or only media with no text: gently ask them to
  reply with some text so you can help. Don't advance the step.
- If they're rude/abusive: stay calm, polite and professional; don't retaliate.
- If they ask something IMPORTANT you genuinely can't answer from the script or knowledge
  base, or something that needs a human (specific car stock, a specific quote/price they
  insist on, a complaint, an unusual or complex personal-finance situation, or they ask to
  speak to a person): set "escalate" to true, put a one-line "escalationNote" describing what
  they need, warmly reassure them a colleague will help with that, and STAY on the current
  step. Do NOT escalate for ordinary questions you can already answer (HP vs PCP, mileage,
  balloon, documents, how the soft search works) — answer those yourself.
- Never invent prices, specific car stock, or guarantees of acceptance.
- Keep customerName and financePreference updated whenever you learn them.

MESSAGE SPLITTING:
- "messages" is an array. USUALLY it has ONE element (one WhatsApp bubble).
- Use TWO elements only when it genuinely reads better as separate bubbles — e.g. a short
  warm acknowledgement first, then the next scripted question as its own message. This mirrors
  how a real rep texts ("Perfect, thanks Ritu!" / then "So, do you know how finance works?").
- Keep each VERBATIM scripted message (intro, the explainer, consent, apply) as ONE single
  element — never split a scripted message across bubbles.
- Never return more than 4 elements.

OUTPUT FORMAT — respond with a SINGLE valid JSON object and NOTHING else (no markdown, no
code fences, no commentary). Schema:
{
  "messages": ["<first bubble>", "<optional second bubble>"],
  "step": "<the step the conversation is on AFTER this reply: one of intro,
           finance_understanding, finance_explainer, consent, apply, confirm_form, handoff>",
  "customerName": "<full name if known, else null>",
  "financePreference": "<\\"HP\\", \\"PCP\\", or null>",
  "partExRequested": <true ONLY when the customer is asking about part-exchange / trading in
                      their current car, else false>,
  "partExDetailsProvided": <true ONLY on the turn where the customer actually sends their
                            current car's details (reg / mileage / settlement figure etc.),
                            else false>,
  "wantsExplainer": <true ONLY when the customer has asked for the finance run-through.
                     FALSE when they said they already know how finance works.>,
  "escalate": <true ONLY when the customer has asked an IMPORTANT question you genuinely
               cannot answer from the script or knowledge base and a human should step in
               (specific car stock, a specific quote/price they insist on, a complaint, an
               unusual or complex personal-finance situation, or they ask to speak to a
               person), else false>,
  "escalationNote": "<if escalate is true, one short sentence saying what they asked / need,
                      else null>",
  "handoff": <true only when the form is confirmed completed and you've handed to Zavia, else false>
}`;

// Build the transcript the model reads.
function buildTranscript(history) {
  if (!history || history.length === 0) return "(no previous messages)";
  return history
    .map((m) => {
      const who = m.direction === "incoming" ? "Customer" : "Charlie";
      return `${who}: ${m.text}`;
    })
    .join("\n");
}

// Defensive JSON extraction (handles stray text/code fences just in case).
function extractJson(raw) {
  if (!raw) return null;
  const text = raw.replace(/```(?:json)?/gi, "").trim();

  // Walk the string, tracking string/escape state, and yield each top-level
  // {...} block. Return the FIRST that parses into our expected shape. This
  // skips any reasoning prose the model emits before/between JSON objects
  // (e.g. "Wait, I need to redo this. {...}") which a greedy first-{ to last-}
  // slice would otherwise swallow and fail to parse.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0,
      inStr = false,
      esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') inStr = !inStr;
      else if (!inStr && c === "{") depth++;
      else if (!inStr && c === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          try {
            const obj = JSON.parse(candidate);
            if (obj && (Array.isArray(obj.messages) || typeof obj.reply === "string")) {
              return obj;
            }
          } catch (_) {
            /* not valid JSON, keep scanning */
          }
          break; // move the outer loop past this block
        }
      }
    }
  }
  return null;
}

const VALID_STEPS = [
  "intro",
  "finance_understanding",
  "finance_explainer",
  "consent",
  "apply",
  "confirm_form",
  "handoff",
];

/**
 * Ask Claude for the next reply given the conversation state.
 * @returns {Promise<{reply:string, step:string, customerName:?string,
 *                     financePreference:?string, handoff:boolean, error?:boolean}>}
 */
async function generateReply({
  step = "intro",
  customerName = null,
  financePreference = null,
  partExSent = false,
  history = [],
}) {
  const userContent = [
    `CURRENT STEP: ${step}`,
    `KNOWN CUSTOMER NAME: ${customerName || "unknown"}`,
    `KNOWN FINANCE PREFERENCE: ${financePreference || "unknown"}`,
    `PART-EXCHANGE DETAILS ALREADY REQUESTED: ${partExSent ? "yes" : "no"}`,
    "",
    "CONVERSATION SO FAR (oldest first; the last line is the message you must respond to):",
    buildTranscript(history),
    "",
    "Now produce the JSON object for your next reply.",
  ].join("\n");

  // up to 2 attempts to get parseable JSON
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const msg = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      });

      const rawText = (msg.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      const parsed = extractJson(rawText);

      // accept either a "messages" array or a legacy single "reply" string
      let replies = null;
      if (parsed) {
        if (Array.isArray(parsed.messages)) {
          replies = parsed.messages
            .filter((m) => typeof m === "string" && m.trim())
            .map((m) => m.trim());
        } else if (typeof parsed.reply === "string" && parsed.reply.trim()) {
          replies = [parsed.reply.trim()];
        }
      }

      if (replies && replies.length > 0) {
        // Part-exchange / trading-in: send the model's short ack, then the EXACT
        // details-request script, in the SAME turn. But send that form ONLY ONCE
        // per conversation - if we've already sent it, never send it again (this
        // stops the loop where every "ok I'll send them" re-triggered the form).
        if (parsed.partExRequested === true && !partExSent) {
          let pref = parsed.financePreference;
          if (pref !== "HP" && pref !== "PCP") pref = financePreference || null;
          return {
            replies: withScript(replies, SCRIPTS.part_ex),
            step, // unchanged
            customerName: parsed.customerName || customerName || null,
            financePreference: pref,
            partExSent: true, // remember we've sent it
            partExDetailsProvided: false, // they're asking, not sending details yet
            handoff: false,
            escalate: false,
            escalationNote: null,
            error: false,
          };
        }

        const nextStep = VALID_STEPS.includes(parsed.step) ? parsed.step : step;

        // GUARANTEE the explainer is delivered the moment the customer reaches
        // this step — but ONLY if they actually asked for the run-through. If
        // they told us they already know how finance works, wantsExplainer is
        // false and we never dump the explainer on them.
        if (
          nextStep === "finance_explainer" &&
          step !== "finance_explainer" &&
          parsed.wantsExplainer !== false
        ) {
          replies = withScript(replies, SCRIPTS.finance_explainer);
        }

        // GUARANTEE the consent + apply scripts are delivered VERBATIM the moment
        // the customer arrives at those steps, exactly like the explainer above.
        // Previously these were left to the model to retype from the prompt, and
        // it paraphrased them ("So just to confirm your eligibility, is it okay if
        // I get you to complete a soft search...") — then the REAL script went out
        // a turn later, so the customer was asked for consent TWICE and had to say
        // "yes" twice before the form link appeared. Injecting them here makes the
        // wording exact and keeps the funnel to one turn per step.
        if (nextStep === "consent" && step !== "consent") {
          replies = withScript(replies, SCRIPTS.consent);
        }

        if (nextStep === "apply" && step !== "apply") {
          replies = withScript(replies, SCRIPTS.apply);
        }

        let pref = parsed.financePreference;
        if (pref !== "HP" && pref !== "PCP") pref = financePreference || null;
        const escalate = parsed.escalate === true;
        return {
          replies: replies.slice(0, 4), // safety cap on bubbles per turn
          step: nextStep,
          customerName: parsed.customerName || customerName || null,
          financePreference: pref,
          // true only on the turn the customer actually sends their car details
          partExDetailsProvided: parsed.partExDetailsProvided === true,
          handoff: parsed.handoff === true || nextStep === "handoff",
          escalate,
          escalationNote:
            escalate && typeof parsed.escalationNote === "string"
              ? parsed.escalationNote.trim()
              : null,
          partExSent, // preserve the flag once set
          error: false,
        };
      }
      console.error(`aiBrain: unparseable response (attempt ${attempt}):`, rawText?.slice(0, 300));
    } catch (err) {
      console.error(`aiBrain: API error (attempt ${attempt}):`, err.message);
    }
  }

  // graceful fallback — never advances the step, sends a safe holding line
  return {
    replies: [
      "Thanks for your message! I'm just having a quick technical hiccup — one of the team will be right with you.",
    ],
    step,
    customerName,
    financePreference,
    partExSent,
    partExDetailsProvided: false,
    handoff: false,
    escalate: false,
    escalationNote: null,
    error: true,
  };
}

// ---------------------------------------------------------------------------
// Feature 1 helper: short internal handover note for the sales team, written
// from the full chat transcript. Used by services/notifications.js at handoff.
// ---------------------------------------------------------------------------
async function summariseConversation(history = []) {
  const transcript = buildTranscript(history);
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      system:
        "You write a brief internal handover note for a car-finance sales colleague who is about to call this lead. " +
        "In 3-5 short sentences cover: who the customer is, what car/finance they want (HP or PCP if known), " +
        "how far they got in the process, and anything useful to know before calling. " +
        "Be factual and concise. Plain text only, no preamble, no markdown.",
      messages: [
        {
          role: "user",
          content: `Conversation transcript:\n${transcript}\n\nWrite the handover note.`,
        },
      ],
    });

    const text = (msg.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    return text || "(summary unavailable)";
  } catch (err) {
    console.error("summariseConversation error:", err.message);
    // fallback: last few customer lines so the colleague still has context
    const recent = (history || [])
      .filter((m) => m.direction === "incoming")
      .slice(-5)
      .map((m) => `- ${m.text}`)
      .join("\n");
    return `(AI summary unavailable) Recent customer messages:\n${recent || "none"}`;
  }
}

module.exports = { generateReply, summariseConversation, SCRIPTS, MODEL };