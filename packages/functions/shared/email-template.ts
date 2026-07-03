// Fragmento de formato reutilizable para prompts de Claude que generan emails con la
// identidad visual de LeadPilot (cajas de señal, botón CTA, firma, pie CAN-SPAM).
// generate-report/regenerate-email tienen su propia copia ya probada en producción —
// este módulo es para código nuevo (como followup-sequencer) que no debe reinventarla.

export const SIGNAL_BOX_FORMAT = `<div style="display:flex;gap:12px;padding:11px 14px;background:#F8F8F7;border-left:2px solid #C0392B;margin-bottom:6px;">
<span style="color:#C0392B;font-size:13px;flex-shrink:0;line-height:1.65;">&rarr;</span>
<span style="font-size:13.5px;line-height:1.6;color:#1A1A1A;">[problema en frase completa]</span>
</div>`;

export function emailFooterFormat(opts: { bookingUrl: string; canSpamAddress: string }): string {
  return `<div style="text-align:center;margin:22px 0;">
<a href="__REPORT_URL__" style="display:inline-block;background:#1A1A1A;color:#ffffff;text-decoration:none;font-size:13.5px;font-weight:700;padding:11px 22px;border-radius:3px;">See full breakdown &rarr;</a>
<p style="font-size:12px;color:#999999;margin-top:10px;margin-bottom:0;">Full analysis with scores, priorities and screenshots</p>
</div>

<hr style="border:none;border-top:1px solid #EBEBEA;margin:22px 0;">

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">Worth 30 minutes? <a href="${opts.bookingUrl}" style="color:#4338CA;">Book a free call here</a></p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">Free 30-min call to find out exactly what's slowing your site down and what it's costing you in ad spend.<br>
No pitch, no commitment. If I don't see a clear problem I can fix, I'll tell you straight.</p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">Or learn more about the <a href="https://tallerdedigitalizacion.com/en/web-audit/" style="color:#4338CA;">Web Audit service &rarr;</a></p>

<hr style="border:none;border-top:1px solid #EBEBEA;margin:22px 0;">

<div style="font-size:13px;color:#555555;line-height:1.8;">
&mdash;<br>
Pablo Leone<br>
Web Infrastructure &amp; WordPress Care<br>
<a href="https://tallerdedigitalizacion.com/en/web-audit/" style="color:#4338CA;text-decoration:none;">tallerdedigitalizacion.com/en/web-audit</a><br>
info@tallerdedigitalizacion.com
</div>

<p style="font-size:11px;color:#999999;margin-top:14px;">
${opts.canSpamAddress}<br>
<a href="__UNSUBSCRIBE_URL__" style="color:#999999;">Unsubscribe</a>
</p>`;
}
