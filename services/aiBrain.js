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
    "Hey it’s Charlie and I'm a sales assistant here at from Zenith, I'll help with the initial part of the process and then a member of the team will contact you to help source your car. Can I start by confirming your full name please? And are you looking to get a car on finance?",

  finance_understanding:
    "Perfect okay, so do you know how finance works? Or would you like me to run you through it?",

  // Sent as 3 separate WhatsApp bubbles (the single block exceeds WhatsApp's
  // 1600-char limit). Wording kept verbatim; <br/> tags replaced with real breaks.
  finance_explainer: [
    "Okay no problem, So there's two types of agreements you can go for:\n\nHp - pay monthly instalments and at the end of the agreement the car is yours\n\nPcp - pay cheaper monthly instalments with the option of part exchanging at the half way point. At the end of the agreement you give the car back, part exchange or pay a “balloon” payment if you want to keep that exact car. It’s up-to you which one you opt for. Some people prefer to own their car at the end of the agreement and keep it for a long while. Some prefer to be able to part exchange it. Which one would you prefer? Bear in mind, the quotes on my page are mostly pcp quotes.",
    "1.0 trading car\n\nYou can trade the car back early, you’d just need to contact us with the cars reg, current mileage and we’d need to know your balance outstanding on your finance. We will then pay the finance off and buy your car in and then you’ll start a new finance agreement\n\n1.1 mileage limit\n\nThere is a mileage limit and you can adjust it, but it mainly comes into play if you give the car back to the finance company. The contracted mileage limit won’t apply if you sell the car back to us or sell it privately.",
    "1.2 balloon payment explanation\n\nA balloon payment is an optional final payment you make to own the car. You don’t need to pay it, most customers after 3/4 years generally want an upgrade as newer models are out by then\n\n1.3 Finance documents needed\n\nThe documents you need vary depending on the lender but typically you need proof of income, proof of address and proof of ID",
  ],

  consent:
    "Okay got you. I just need to confirm your finance eligibility then I’ll take some details about the car you want and send you through some personalised quotes. Is it okay if I can get you to complete a soft search against one of our cars on our website? It’s just a soft search so no impact on your score :)",

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
- Trading the car back early: contact us with the car's reg, current mileage and the
  outstanding finance balance. If it's worth more than the balance they can trade with no
  cash in; if worth less they can add cash to settle or roll it into the new contract.
- Mileage limit: adjustable; mainly matters if the car is given back to the finance
  company. It does not apply if they sell back to us or sell privately. Higher mileage can
  reduce a valuation and risk negative equity (e.g. 80k is worth more than 100k).
- Balloon payment: an optional final payment to own the car; not required. Most customers
  upgrade after 3/4 years.
- Documents (vary by lender): typically proof of income, proof of address, proof of ID.
- Soft search: no impact on credit score.
`;

const SYSTEM_PROMPT = `You are "Charlie", a friendly sales assistant for Zenith Motor Company,
talking to a customer over WhatsApp. You handle the FIRST part of the process (lead
qualification) and then hand the customer to a colleague named Zavia.

Always keep a warm, friendly, casual-but-professional WhatsApp tone. Never be pushy.

NEVER use emojis in your messages (no 😊, 🙂, 👍, etc.). Keep the warmth in your wording,
not in emojis. Plain text only.

You move the customer through these conversational steps IN ORDER:
1. intro                -> get their full name AND confirm they want a car on finance.
2. finance_understanding-> ask if they understand how finance works / want a run-through.
3. finance_explainer    -> send the HP/PCP + trading/mileage/balloon/documents explainer.
4. consent              -> ask consent to do a soft search.
5. apply                -> send the enquiry form link.
6. confirm_form         -> wait for them to confirm the form is completed, then hand off.

THE CANONICAL SCRIPTED MESSAGES (send these EXACTLY, word-for-word, when you deliver
that step's main message — do not paraphrase, do not change spelling/punctuation):

[intro]
${SCRIPTS.intro}

[finance_understanding]
${SCRIPTS.finance_understanding}

[finance_explainer] — send these as THREE separate messages (3 elements in the "messages"
array), each verbatim, in this order:
  (bubble 1) ${SCRIPTS.finance_explainer[0]}
  (bubble 2) ${SCRIPTS.finance_explainer[1]}
  (bubble 3) ${SCRIPTS.finance_explainer[2]}

[consent]
${SCRIPTS.consent}

[apply]
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
- Send only ONE message back per turn (the single most appropriate next message).
- At the finance_explainer step you do NOT need them to have answered HP vs PCP first — the
  explainer itself asks that. Send the explainer when they reach this step.
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
- If they ask something you genuinely can't answer from the knowledge base: say a colleague
  will confirm the details, and continue the current step.
- Never invent prices, specific car stock, or guarantees of acceptance.
- Keep customerName and financePreference updated whenever you learn them.

MESSAGE SPLITTING:
- "messages" is an array. USUALLY it has ONE element (one WhatsApp bubble).
- Use TWO elements only when it genuinely reads better as separate bubbles — e.g. a short
  warm acknowledgement first, then the next scripted question as its own message. This mirrors
  how a real rep texts ("Perfect, thanks Ritu!" / then "So, do you know how finance works?").
- Keep each VERBATIM scripted message (intro, the explainer, consent, apply) as ONE single
  element — never split a scripted message across bubbles.
- Never return more than 3 elements.

OUTPUT FORMAT — respond with a SINGLE valid JSON object and NOTHING else (no markdown, no
code fences, no commentary). Schema:
{
  "messages": ["<first bubble>", "<optional second bubble>"],
  "step": "<the step the conversation is on AFTER this reply: one of intro,
           finance_understanding, finance_explainer, consent, apply, confirm_form, handoff>",
  "customerName": "<full name if known, else null>",
  "financePreference": "<\\"HP\\", \\"PCP\\", or null>",
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
  let text = raw.trim();
  // strip code fences if present
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    return null;
  }
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
  history = [],
}) {
  const userContent = [
    `CURRENT STEP: ${step}`,
    `KNOWN CUSTOMER NAME: ${customerName || "unknown"}`,
    `KNOWN FINANCE PREFERENCE: ${financePreference || "unknown"}`,
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
        const nextStep = VALID_STEPS.includes(parsed.step) ? parsed.step : step;
        let pref = parsed.financePreference;
        if (pref !== "HP" && pref !== "PCP") pref = financePreference || null;
        return {
          replies: replies.slice(0, 3), // safety cap
          step: nextStep,
          customerName: parsed.customerName || customerName || null,
          financePreference: pref,
          handoff: parsed.handoff === true || nextStep === "handoff",
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
    handoff: false,
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