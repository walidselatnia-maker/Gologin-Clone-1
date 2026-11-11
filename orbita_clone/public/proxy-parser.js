// Smart Proxy String Parser & Auto-Detector
function parseProxyString(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let str = raw.trim();

  // Strip wrapping quotes if any
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1).trim();
  }

  let mode = 'http';

  // 1. Check protocol prefix (http://, https://, socks5://, socks4://)
  if (/^socks5:\/\//i.test(str)) {
    mode = 'socks5';
    str = str.replace(/^socks5:\/\//i, '');
  } else if (/^socks4:\/\//i.test(str)) {
    mode = 'socks4';
    str = str.replace(/^socks4:\/\//i, '');
  } else if (/^https?:\/\//i.test(str)) {
    mode = 'http';
    str = str.replace(/^https?:\/\//i, '');
  }

  // 2. Format: user:pass@host:port (split on LAST '@' to support '@' in passwords)
  if (str.includes('@')) {
    const lastAt = str.lastIndexOf('@');
    const authPart = str.slice(0, lastAt);
    const hostPart = str.slice(lastAt + 1);
    
    const firstColonAuth = authPart.indexOf(':');
    let username = authPart;
    let password = '';
    if (firstColonAuth !== -1) {
      username = authPart.slice(0, firstColonAuth);
      password = authPart.slice(firstColonAuth + 1);
    }

    const hostTokens = hostPart.split(':');
    return {
      mode,
      host: hostTokens[0] ? hostTokens[0].trim() : '',
      port: hostTokens[1] ? hostTokens[1].trim() : '',
      username: username.trim(),
      password: password.trim()
    };
  }

  // 3. Delimiter detection (tab, comma, semicolon, space, or colon)
  let tokens = [];
  if (str.includes('\t')) tokens = str.split('\t');
  else if (str.includes(';')) tokens = str.split(';');
  else if (str.includes(',')) tokens = str.split(',');
  else if (str.includes(' ') && !str.includes(':')) tokens = str.split(/\s+/);
  else tokens = str.split(':');

  tokens = tokens.map(t => t.trim()).filter(Boolean);

  if (tokens.length === 2) {
    // host:port
    return {
      mode,
      host: tokens[0],
      port: tokens[1],
      username: '',
      password: ''
    };
  }

  if (tokens.length >= 4) {
    // Check if tokens[1] is a numeric port -> host:port:user:pass
    const isSecondTokenPort = !isNaN(tokens[1]) && parseInt(tokens[1], 10) > 0 && parseInt(tokens[1], 10) <= 65535;
    if (isSecondTokenPort) {
      // host:port:username:password
      return {
        mode,
        host: tokens[0],
        port: tokens[1],
        username: tokens[2],
        password: tokens.slice(3).join(':')
      };
    } else {
      // username:password:host:port
      const portIdx = tokens.findIndex((t, idx) => idx > 0 && !isNaN(t) && parseInt(t, 10) > 0 && parseInt(t, 10) <= 65535);
      if (portIdx > 1) {
        return {
          mode,
          host: tokens[portIdx - 1],
          port: tokens[portIdx],
          username: tokens[0],
          password: tokens.slice(1, portIdx - 1).join(':')
        };
      }
    }
  }

  if (tokens.length === 3) {
    // Could be host:port:username or protocol:host:port
    if (!isNaN(tokens[1])) {
      return {
        mode,
        host: tokens[0],
        port: tokens[1],
        username: tokens[2],
        password: ''
      };
    }
  }

  if (tokens.length === 1) {
    return {
      mode,
      host: tokens[0],
      port: '',
      username: '',
      password: ''
    };
  }

  return null;
}

if (typeof module !== 'undefined') module.exports = { parseProxyString };
