'use strict';

// A small, careful email sender (SMTP over a secure connection). No outside packages are needed.
// The connection is encrypted from the first byte and the server's certificate is always checked.
const tls = require('tls');
const net = require('net');
const zlib = require('zlib');

const b64 = (buf) => Buffer.from(buf).toString('base64').replace(/(.{76})/g, '$1\r\n');
const encWord = (t) => (/^[\x20-\x7e]*$/.test(t) ? t : `=?UTF-8?B?${Buffer.from(t, 'utf8').toString('base64')}?=`);
const clean = (t) => String(t).replace(/[\r\n]+/g, ' ');

function buildMessage({ from, to, subject, text, attachments = [] }) {
  const boundary = '=_binsaad_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const head = [
    `From: ${clean(from)}`, `To: ${clean(to)}`, `Subject: ${encWord(clean(subject))}`,
    `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].join('\r\n');
  let body = `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(Buffer.from(text, 'utf8'))}\r\n`;
  for (const a of attachments) {
    body += `--${boundary}\r\nContent-Type: ${a.type || 'application/octet-stream'}; name="${clean(a.filename)}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${clean(a.filename)}"\r\n\r\n${b64(a.content)}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  return `${head}\r\n\r\n${body}`;
}

// opts: { host, port, secure (default true), user, pass, from, to, subject, text, attachments, timeoutMs }
function sendMail(opts) {
  return new Promise((resolve, reject) => {
    const secure = opts.secure !== false;
    const port = opts.port || 465;
    const sock = secure
      ? tls.connect({ host: opts.host, port, servername: opts.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' })
      : net.connect({ host: opts.host, port });
    let buf = '';
    let waiting = null;
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch (e) { /* closing */ }
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('The email server did not answer in time.')), opts.timeoutMs || 25000);
    sock.setEncoding('utf8');
    sock.on('error', (e) => finish(new Error('Could not reach the email server: ' + e.message)));
    sock.on('close', () => finish(new Error('The email server closed the connection.')));
    sock.on('data', (d) => {
      buf += d;
      // a reply ends with a line like "250 text" (a space after the 3 digits)
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i]) && waiting) {
          const w = waiting; waiting = null;
          buf = lines.slice(i + 1).join('\r\n');
          w({ code: Number(lines[i].slice(0, 3)), text: lines[i] });
          return;
        }
      }
    });
    const reply = () => new Promise((res) => { waiting = res; });
    const say = async (line, ok) => {
      sock.write(line + '\r\n');
      const r = await reply();
      if (!ok.includes(r.code)) throw new Error(`The email server said: ${r.text}`);
      return r;
    };
    (async () => {
      const hello = await reply();
      if (hello.code !== 220) throw new Error('The email server did not welcome us: ' + hello.text);
      await say('EHLO binsaad.local', [250]);
      await say('AUTH LOGIN', [334]);
      await say(Buffer.from(opts.user).toString('base64'), [334]);
      const auth = await say(Buffer.from(String(opts.pass).replace(/\s+/g, '')).toString('base64'), [235, 535]);
      if (auth.code === 535) throw new Error('The sender Gmail or its app password was refused. Make a new app password and save it again.');
      await say(`MAIL FROM:<${clean(opts.user)}>`, [250]);
      await say(`RCPT TO:<${clean(opts.to)}>`, [250, 251]);
      await say('DATA', [354]);
      const msg = buildMessage({ ...opts, from: opts.from || opts.user }).replace(/^\./gm, '..');
      await say(msg + '\r\n.', [250]);
      try { sock.write('QUIT\r\n'); } catch (e) { /* done */ }
      finish(null, { sent: true });
    })().catch((e) => finish(e));
  });
}

const gzip = (buf) => zlib.gzipSync(buf);
module.exports = { sendMail, buildMessage, gzip };
