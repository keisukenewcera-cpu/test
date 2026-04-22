import { Resend } from 'resend'

const resendApiKey = process.env.RESEND_API_KEY
const fromEmail = process.env.MAIL_FROM ?? 'onboarding@resend.dev'
const toEmail = 'keisuke.newcera@gmail.com'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  if (!resendApiKey) {
    res.status(500).json({ error: 'RESEND_API_KEY is not configured' })
    return
  }

  const { csvContent, fileName } = req.body ?? {}
  if (!csvContent || typeof csvContent !== 'string') {
    res.status(400).json({ error: 'csvContent is required' })
    return
  }

  try {
    const resend = new Resend(resendApiKey)
    const csvBase64 = Buffer.from(csvContent, 'utf-8').toString('base64')
    const safeFileName = typeof fileName === 'string' && fileName ? fileName : 'performance_allowance.csv'

    const result = await resend.emails.send({
      from: fromEmail,
      to: [toEmail],
      subject: '業績手当CSV送付',
      html: '<p>業績手当CSVを送付します。</p>',
      attachments: [
        {
          filename: safeFileName,
          content: csvBase64,
        },
      ],
    })

    res.status(200).json({ ok: true, id: result.data?.id ?? null })
  } catch (error) {
    res.status(500).json({ error: error?.message ?? 'Failed to send email' })
  }
}
