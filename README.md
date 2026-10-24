# whatsapp-twilio-api

## The CRM

The CRM (admin_crm) shows these leads on two pages — **Needs Attention** and
**WhatsApp Leads** — by reading this service's database. Anything it does to a
lead (reply as a person, take over, hand back, snooze, change the stage,
resolve an escalation, resend a first message) it writes as a command into
`crm_lead_commands`; `services/crmBridge.js` runs each one with this service's
own functions (the same takeover / resume / snooze as the Telegram bot). No new
route; MongoDB is the channel.

The bridge also keeps on each lead:

- `escalation` / `escalations` — the webhook records every "lead needs a human"
  escalation (it used to be sent as a WhatsApp alert only), open until someone
  resolves it in the CRM or replies from the CRM;
- `stuck` — the stuck-lead rules (`services/stuckLeads.js#evaluateLead`) applied
  to every lead every 5 minutes, with no age cap, cleared when the lead replies;
- `humanOwner` — who in the CRM took the lead over.

```
CRM_BRIDGE=off              # don't take CRM commands
CRM_POLL_MS=1500
CRM_STUCK_SWEEP_MS=300000
ADMIN_API_KEY=              # recommended: makes /messages, /send-whatsapp,
                            # /stuck-leads, /leads-to-message, /sourcing-requests,
                            # /senders, /telegram/status and /statuses require
                            # the header x-api-key. Unset = open, as before.
```

`npm test` runs the bridge against a real mongod (Twilio is a stand-in).
Details: admin_crm/docs/WHATSAPP_LEADS_INTEGRATION.md.
