const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Store connected clients
// Map of clientId -> { ws, id, name, avatar, color, device, ip }
const clients = new Map();

// Random naming generators
const ADJECTIVES = ['Sleek', 'Golden', 'Swift', 'Silent', 'Clever', 'Wild', 'Frosty', 'Cosmic', 'Hyper', 'Mystic', 'Brave', 'Sparkly'];
const ANIMALS = ['Panther', 'Eagle', 'Dolphin', 'Fox', 'Koala', 'Falcon', 'Cheetah', 'Owl', 'Otter', 'Panda', 'Tiger', 'Penguin', 'Wolf', 'Badger'];
const COLORS = [
  'linear-gradient(135deg, #FF6B6B, #FF8E53)', // Red/Orange
  'linear-gradient(135deg, #4E54C8, #8F94FB)', // Indigo/Blue
  'linear-gradient(135deg, #11998E, #38EF7D)', // Green/Mint
  'linear-gradient(135deg, #FC466B, #3F5EFB)', // Pink/Blue
  'linear-gradient(135deg, #F9D423, #FF4E50)', // Yellow/Red
  'linear-gradient(135deg, #00C6FF, #0072FF)', // Cyan/Blue
  'linear-gradient(135deg, #7F00FF, #E100FF)', // Purple/Magenta
  'linear-gradient(135deg, #F857A6, #FF5858)', // Coral/Pink
  'linear-gradient(135deg, #1D2671, #C33764)'  // Deep Night
];

function getRandomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generatePeerName() {
  return `${getRandomItem(ADJECTIVES)} ${getRandomItem(ANIMALS)}`;
}

// Extract clean system metadata from User-Agent
function getDeviceDetails(userAgent) {
  let osName = 'Unknown OS';
  let browserName = 'Unknown Browser';
  let deviceType = 'desktop'; // desktop, mobile, tablet
  
  if (!userAgent) return { os: osName, browser: browserName, type: deviceType };
  
  const ua = userAgent.toLowerCase();
  
  // OS Detection
  if (ua.includes('iphone')) {
    osName = 'iOS';
    deviceType = 'mobile';
  } else if (ua.includes('ipad')) {
    osName = 'iOS';
    deviceType = 'tablet';
  } else if (ua.includes('android')) {
    osName = 'Android';
    deviceType = ua.includes('mobile') ? 'mobile' : 'tablet';
  } else if (ua.includes('macintosh') || ua.includes('mac os')) {
    osName = 'macOS';
  } else if (ua.includes('windows')) {
    osName = 'Windows';
  } else if (ua.includes('linux')) {
    osName = 'Linux';
  }
  
  // Browser Detection
  if (ua.includes('chrome') || ua.includes('crios')) {
    browserName = 'Chrome';
  } else if (ua.includes('safari') && !ua.includes('chrome') && !ua.includes('chromium')) {
    browserName = 'Safari';
  } else if (ua.includes('firefox') || ua.includes('fxios')) {
    browserName = 'Firefox';
  } else if (ua.includes('edge') || ua.includes('edg')) {
    browserName = 'Edge';
  } else if (ua.includes('opera') || ua.includes('opr')) {
    browserName = 'Opera';
  }
  
  return { os: osName, browser: browserName, type: deviceType };
}

// Get all IPv4 local addresses on active interfaces
function getLocalIPAddresses() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  
  for (const name in interfaces) {
    for (const iface of interfaces[name]) {
      // We want IPv4 and non-internal loopbacks
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

// Broadcast active peer list to all clients
function broadcastPeerList() {
  const peerList = Array.from(clients.values()).map(c => ({
    id: c.id,
    name: c.name,
    color: c.color,
    device: c.device
  }));
  
  for (const [clientId, client] of clients.entries()) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({
        type: 'peers-update',
        peers: peerList.filter(p => p.id !== clientId) // send others only
      }));
    }
  }
}

wss.on('connection', (ws, req) => {
  const clientId = Math.random().toString(36).substring(2, 11);
  const userAgent = req.headers['user-agent'];
  const device = getDeviceDetails(userAgent);
  const peerName = generatePeerName();
  const avatarColor = getRandomItem(COLORS);
  
  const clientInfo = {
    id: clientId,
    name: peerName,
    color: avatarColor,
    device: device,
    ws: ws
  };
  
  clients.set(clientId, clientInfo);
  console.log(`[Connected] Peer ${peerName} (${clientId}) - OS: ${device.os}, Type: ${device.type}`);
  
  const serverIPs = getLocalIPAddresses();
  const primaryIP = serverIPs[0] || 'localhost';
  
  // Send connection confirmation & personal info back to client
  ws.send(JSON.stringify({
    type: 'init',
    info: {
      id: clientId,
      name: peerName,
      color: avatarColor,
      device: device
    },
    localIPs: serverIPs,
    primaryIP: primaryIP,
    port: PORT
  }));
  
  // Broadcast new peer list to everyone
  broadcastPeerList();
  
  // Message handling
  ws.on('message', (messageText) => {
    try {
      const message = JSON.parse(messageText);
      
      // Rename message handler
      if (message.type === 'rename') {
        const newName = message.name.trim();
        if (newName && newName.length <= 30) {
          const clientInfo = clients.get(clientId);
          if (clientInfo) {
            clientInfo.name = newName;
            console.log(`[Rename] Peer ${clientId} changed name to: ${newName}`);
            broadcastPeerList();
          }
        }
        return;
      }
      
      const targetId = message.target;
      
      // Target must exist
      if (targetId && clients.has(targetId)) {
        const targetClient = clients.get(targetId);
        
        // Attach the sender ID to trace where the signal/relay originates
        message.sender = clientId;
        
        if (targetClient.ws.readyState === WebSocket.OPEN) {
          targetClient.ws.send(JSON.stringify(message));
        }
      }
    } catch (err) {
      console.error('Error processing WS message:', err);
    }
  });
  
  // Connection cleanup
  ws.on('close', () => {
    clients.delete(clientId);
    console.log(`[Disconnected] Peer ${peerName} (${clientId})`);
    broadcastPeerList();
  });
  
  ws.on('error', (err) => {
    console.error(`[Error] Client ${clientId}:`, err);
    clients.delete(clientId);
    broadcastPeerList();
  });
});

// Serve local API configuration details just in case
app.get('/api/info', (req, res) => {
  res.json({
    localIPs: getLocalIPAddresses(),
    port: PORT
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPAddresses();
  console.log('========================================================');
  console.log(`DropIt server running on port ${PORT}`);
  console.log('Access from this machine: http://localhost:' + PORT);
  console.log('Access from other devices on local network:');
  ips.forEach(ip => {
    console.log(`  http://${ip}:${PORT}`);
  });
  console.log('========================================================');
});
