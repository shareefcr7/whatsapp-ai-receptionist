# Cost estimation: 1,000 conversations a month

Planning estimate only. **No subscription or purchase is authorized or implied.** Prices were checked on 9 November 2026, exclude taxes, and can change.

## Summary

| Category | Monthly estimate | Confidence |
| --- | --- | --- |
| OpenAI API | **$1.95 to $6.75**, depending on model | Verified list prices, assumed token counts |
| WhatsApp messaging | **9,000 billable messages × market rate, plus templates** | Rule verified, **rate pending** |
| Hosting | **Pending** | $0 extra only if an existing VPS has spare capacity |
| Database | **Pending** | $0 extra if self-hosted on that VPS; backups still need storage |
| Google Calendar API | **$0 expected** | Verified, well under the limits |

No total is given, because two categories have no verified price yet.

**Main finding:** WhatsApp, not AI, may be the largest variable cost. Since 1 October 2026, Meta charges for service messages beyond 1,000 a month per number, so the common assumption that replies inside the 24-hour window are free no longer holds.

## Assumptions

| Input | Value |
| --- | --- |
| Conversations a month | 1,000 |
| AI responses per conversation | 10 |
| Input tokens per response | 1,500 |
| Output tokens per response | 300 |
| AI responses a month | 1,000 × 10 = **10,000** |
| **Input tokens a month** | 10,000 × 1,500 = **15,000,000** |
| **Output tokens a month** | 10,000 × 300 = **3,000,000** |

These are the initial planning figures, not measurements. Conversation history grows input tokens as a chat gets longer, so replace them with `usage_logs` data once live.

## OpenAI API

**Formula**

```text
monthly cost = (input tokens ÷ 1,000,000 × input price) + (output tokens ÷ 1,000,000 × output price)
             = (15 × input price) + (3 × output price)
```

**Comparison** (standard tier, USD per 1M tokens)

| Model | Input | Cached input | Output | Input cost | Output cost | **Monthly** |
| --- | --- | --- | --- | --- | --- | --- |
| `gpt-5-nano` | $0.05 | $0.005 | $0.40 | $0.75 | $1.20 | **$1.95** |
| `gpt-6-luna` | $0.10 | $0.01 | $0.50 | $1.50 | $1.50 | **$3.00** |
| `gpt-4o-mini` | $0.15 | $0.075 | $0.60 | $2.25 | $1.80 | **$4.05** |
| `gpt-5.4-nano` | $0.20 | $0.02 | $1.25 | $3.00 | $3.75 | **$6.75** |

Source: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing).

**Sensitivity**
- **Caching:** if half of input tokens were billed at the cached rate, `gpt-6-luna` falls from $3.00 to $2.33 (7.5 × $0.10 + 7.5 × $0.01 + 3 × $0.50). The share achieved is unknown until tested.
- **Larger context:** doubling to 3,000 input tokens per response takes `gpt-6-luna` to $4.50 (30 × $0.10 + 3 × $0.50).

**Recommendation:** test `gpt-6-luna` and `gpt-5-nano` first. They are the two cheapest here and the difference is about $1 a month, so choose on reply quality, not price. Quality has not been tested for any model. Run the evaluation on Day 4 with real customer questions.

## WhatsApp messaging

Verified rules, from [Meta's pricing documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing.md) (effective 1 October 2026):
- Meta charges per delivered message, by category and recipient country. Messages from customers are free.
- Each business phone number gets **1,000 free service messages a month**, with no rollover. Charges start at the 1,001st.
- Utility templates, such as booking confirmations and reminders, are charged even inside an open service window, unless a free entry point window is open.
- Replies inside a free entry point window (customer arrives from a Click to WhatsApp ad, up to 7 days) are not charged.
- Eligible government and non-profit organizations stay free beyond the tier through 31 December 2027.

**Formula** (one phone number, assuming each AI response is one message)

```text
monthly cost = (max(0, 10,000 − 1,000) × service rate) + (templates sent × template rate)
             = (9,000 × service rate) + (templates sent × template rate)
```

**Pending:**
1. **Target country.** Rates differ by market.
2. **Service and utility rates** for that country. Meta's rate cards are downloadable, but I could not read the figures automatically, and third-party articles disagree with each other, so none are used here. Check the [rate cards](https://developers.facebook.com/docs/whatsapp/pricing#rate-cards).
3. **Templates per month.** For example, one confirmation and one reminder per booking means 2 × monthly bookings.

**Scale only, not a budget figure:** Meta's page uses 0.68¢ per message as a comparison point, based on utility and authentication rates in Brazil. At that rate, 9,000 messages would be $61.20 a month, about 9 to 31 times the AI cost above. Your market's rate may differ considerably.

**To reduce it:** combine AI text into one message rather than several, and answer fully in fewer turns.

## Hosting

**Pending: hosting is undecided.**

| Scenario | Cost |
| --- | --- |
| Existing VPS with spare capacity | $0 extra. Confirm memory and disk first |
| New VPS or platform | Pending a provider quote |

Needs: Node.js 24, a reverse proxy, HTTPS (Let's Encrypt is free), and a public HTTPS URL for WhatsApp webhooks. At this volume (about 20,000 messages in and out a month) a small server should cope, but this has not been load tested.

## Database

| Scenario | Cost |
| --- | --- |
| PostgreSQL on the same VPS | $0 extra, plus off-server backup storage (pending) and our own maintenance |
| Managed PostgreSQL | Pending a provider quote |

## Google Calendar API

Per [Google's quota documentation](https://developers.google.com/workspace/calendar/api/guides/quota): standard use has no additional cost. Limits are 10,000 requests a minute per project, 600 a minute per user, and 1,000,000 a day before charges apply. Google says charges for exceeding quota are planned for later in 2026. Expected volume here is far below these limits, so **$0 expected**.

## Not included

Taxes, staff time, domain name, backup storage, error monitoring, and any fees from a WhatsApp solution partner (this design uses the Cloud API directly).
