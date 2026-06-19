// DropIt Client-Side Application

// State variables
let myId = null;
let myName = '';
let myColor = '';
let myDevice = {};
let peers = new Map(); // id -> { id, name, color, device }
let socket = null;
let peerConnections = new Map(); // peerId -> RTCPeerConnection
let dataChannels = new Map(); // peerId -> RTCDataChannel
let pendingIceCandidates = new Map(); // peerId -> array of candidates (for queuing before remote description)
let sharingHistory = []; // list of history items
let receivedBlobsMap = new Map(); // historyId -> Blob (for dynamic session downloads)

// Active Transfer State
let activeTransfer = {
    peerId: null,
    peerName: '',
    type: null, // 'send' or 'receive'
    mode: null, // 'webrtc' or 'websocket'
    fileName: '',
    fileSize: 0,
    fileType: '',
    chunks: [],
    chunksReceived: 0,
    totalChunks: 0,
    bytesTransferred: 0,
    startTime: 0,
    timer: null,
    isCancelled: false,
    file: null // For sender
};

// Auto-accept state and queue state
let autoAcceptPeerId = null;
let autoAcceptTimeout = null;
let currentQueueIndex = 0;
let currentQueueLength = 0;

// WebSocket Relay fallback timeout reference
let connectionTimeout = null;

// Constants
const CHUNK_SIZE = 65536; // 64KB chunks
const WEBRTC_TIMEOUT = 5000; // 5 seconds to establish WebRTC, then fallback to WS

// Web Audio API Synthesizer (runs offline)
const AudioFeedback = {
    ctx: null,
    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
    },
    playTone(frequencies, duration, type = 'sine') {
        try {
            this.init();
            if (this.ctx.state === 'suspended') {
                this.ctx.resume();
            }
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = type;
            
            const now = this.ctx.currentTime;
            if (Array.isArray(frequencies)) {
                const step = duration / frequencies.length;
                frequencies.forEach((f, idx) => {
                    osc.frequency.setValueAtTime(f, now + (idx * step));
                });
            } else {
                osc.frequency.setValueAtTime(frequencies, now);
            }
            
            gain.gain.setValueAtTime(0.12, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
            
            osc.connect(gain);
            gain.connect(this.ctx.destination);
            
            osc.start(now);
            osc.stop(now + duration);
        } catch (e) {
            console.warn('Audio synthesized tone failed to play:', e);
        }
    },
    playJoin() {
        this.playTone([400, 600], 0.2, 'sine');
    },
    playRequest() {
        this.playTone([440, 554, 659], 0.35, 'sine');
    },
    playSuccess() {
        this.playTone([523, 659, 784, 1046], 0.4, 'sine');
    },
    playError() {
        this.playTone([260, 180], 0.35, 'triangle');
    }
};

// DOM Elements
const el = {
    statusDot: document.getElementById('ws-status').querySelector('.status-dot'),
    statusText: document.getElementById('ws-status').querySelector('.status-text'),
    radarTitle: document.getElementById('radar-title'),
    peersLayer: document.getElementById('peers-layer'),
    myAvatar: document.getElementById('my-avatar'),
    myAvatarCenter: document.getElementById('my-avatar-center'),
    myDeviceIcon: document.getElementById('my-device-icon'),
    myName: document.getElementById('my-name'),
    myDeviceDesc: document.getElementById('my-device-desc'),
    btnTextShare: document.getElementById('btn-text-share'),
    btnShowQr: document.getElementById('btn-show-qr'),
    fileInput: document.getElementById('file-input'),
    
    // QR Modal
    qrModal: document.getElementById('qr-modal'),
    btnCloseQr: document.getElementById('btn-close-qr'),
    qrContainer: document.getElementById('qrcode-container'),
    shareLinkInput: document.getElementById('share-link-input'),
    btnCopyLink: document.getElementById('btn-copy-link'),
    localNetworksIps: document.getElementById('local-networks-ips'),
    
    // Text Share Modal
    textShareModal: document.getElementById('text-share-modal'),
    btnCloseTextShare: document.getElementById('btn-close-text-share'),
    textTargetPeer: document.getElementById('text-target-peer'),
    textToShare: document.getElementById('text-to-share'),
    btnCancelText: document.getElementById('btn-cancel-text'),
    btnSendTextConfirm: document.getElementById('btn-send-text-confirm'),
    
    // Receive Request Modal
    receiveRequestModal: document.getElementById('receive-request-modal'),
    reqSenderAvatar: document.getElementById('req-sender-avatar'),
    reqSenderName: document.getElementById('req-sender-name'),
    reqFileIcon: document.getElementById('req-file-icon'),
    reqFileName: document.getElementById('req-file-name'),
    reqFileSize: document.getElementById('req-file-size'),
    btnDeclineFile: document.getElementById('btn-decline-file'),
    btnAcceptFile: document.getElementById('btn-accept-file'),
    
    // Text Received Modal
    textReceivedModal: document.getElementById('text-received-modal'),
    btnCloseTextReceived: document.getElementById('btn-close-text-received'),
    textReceivedSender: document.getElementById('text-received-sender'),
    textReceivedContent: document.getElementById('text-received-content'),
    btnCloseTextReceivedFooter: document.getElementById('btn-close-text-received-footer'),
    btnCopyReceivedText: document.getElementById('btn-copy-received-text'),
    
    // Progress Modal
    progressModal: document.getElementById('progress-modal'),
    progressTitle: document.getElementById('progress-title'),
    progressFileInfo: document.getElementById('progress-file-info'),
    progressRingBar: document.getElementById('progress-ring-bar'),
    progressPct: document.getElementById('progress-pct'),
    progressSpeed: document.getElementById('progress-speed'),
    progressTimeEta: document.getElementById('progress-time-eta'),
    transferMode: document.getElementById('transfer-mode'),
    btnCancelTransfer: document.getElementById('btn-cancel-transfer'),
    
    // Preview Modal
    previewModal: document.getElementById('preview-modal'),
    btnClosePreview: document.getElementById('btn-close-preview'),
    previewFileTitle: document.getElementById('preview-file-title'),
    previewMediaContainer: document.getElementById('preview-media-container'),
    btnPreviewDone: document.getElementById('btn-preview-done'),
    btnDownloadFile: document.getElementById('btn-download-file'),

    // File Select Modal
    fileSelectModal: document.getElementById('file-select-modal'),
    btnCloseFileSelect: document.getElementById('btn-close-file-select'),
    fileSelectTargetName: document.getElementById('file-select-target-name'),
    fileDropZone: document.getElementById('file-drop-zone'),
    selectedFilesQueue: document.getElementById('selected-files-queue'),
    queueList: document.getElementById('queue-list'),
    btnCancelFileSelect: document.getElementById('btn-cancel-file-select'),
    btnSendFilesConfirm: document.getElementById('btn-send-files-confirm'),
    catImages: document.getElementById('cat-images'),
    catVideos: document.getElementById('cat-videos'),
    catAudio: document.getElementById('cat-audio'),
    catDocs: document.getElementById('cat-docs'),

    // Rename Modal
    profileCardRename: document.getElementById('profile-card-rename'),
    renameModal: document.getElementById('rename-modal'),
    btnCloseRename: document.getElementById('btn-close-rename'),
    btnCancelRename: document.getElementById('btn-cancel-rename'),
    btnSaveRename: document.getElementById('btn-save-rename'),
    inputDeviceName: document.getElementById('input-device-name'),

    // History Modal
    btnShowHistory: document.getElementById('btn-show-history'),
    historyModal: document.getElementById('history-modal'),
    btnCloseHistory: document.getElementById('btn-close-history'),
    btnClearHistory: document.getElementById('btn-clear-history'),
    historyListContainer: document.getElementById('history-list-container'),
    historyEmptyState: document.getElementById('history-empty-state'),
    
    // Toast notifications container
    toastContainer: document.getElementById('toast-container')
};

// Initialize app
function initApp() {
    setupWebSocket();
    setupEventListeners();
    loadSharingHistory();
}

// WebSocket setup
function setupWebSocket() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}`;
    
    updateConnectionStatus('connecting', 'Connecting...');
    
    socket = new WebSocket(wsUrl);
    
    socket.onopen = () => {
        updateConnectionStatus('online', 'Online');
    };
    
    socket.onclose = () => {
        updateConnectionStatus('offline', 'Disconnected. Retrying...');
        clearPeers();
        setTimeout(setupWebSocket, 3000); // Reconnect in 3s
    };
    
    socket.onerror = (err) => {
        console.error('WebSocket Error:', err);
        updateConnectionStatus('offline', 'Connection Error');
    };
    
    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleSocketMessage(data);
        } catch (e) {
            console.error('Failed to parse WebSocket message:', e);
        }
    };
}

function updateConnectionStatus(state, label) {
    el.statusDot.className = `status-dot ${state === 'online' ? 'online' : 'offline'}`;
    el.statusText.textContent = label;
}

// Handle WebSocket commands
function handleSocketMessage(msg) {
    switch (msg.type) {
        case 'init':
            myId = msg.info.id;
            
            // Check for locally saved custom name
            const savedName = localStorage.getItem('dropit_device_name');
            if (savedName) {
                myName = savedName;
                // Send rename update back to server immediately
                socket.send(JSON.stringify({
                    type: 'rename',
                    name: myName
                }));
            } else {
                myName = msg.info.name;
            }
            
            myColor = msg.info.color;
            myDevice = msg.info.device;
            
            // Set my details
            el.myName.textContent = myName;
            el.myAvatar.style.background = myColor;
            el.myAvatarCenter.querySelector('.avatar-core').style.background = myColor;
            el.myDeviceDesc.textContent = `${myDevice.browser} on ${myDevice.os}`;
            
            // Configure Device Icon
            let iconClass = 'fa-laptop';
            if (myDevice.type === 'mobile') iconClass = 'fa-mobile-screen-button';
            if (myDevice.type === 'tablet') iconClass = 'fa-tablet-screen-button';
            el.myDeviceIcon.className = `fa-solid ${iconClass}`;
            
            // Generate QR Code & Networks Info
            generateConnectionQR(msg.localIPs, msg.port, msg.primaryIP);
            break;
            
        case 'peers-update':
            updatePeersList(msg.peers);
            break;
            
        case 'signal':
            // Forward WebRTC signals
            handleWebRtcSignal(msg.sender, msg.signal);
            break;
            
        case 'relay-file-metadata':
            // Relay Fallback - Received meta
            handleRelayFileMetadata(msg.sender, msg);
            break;
            
        case 'relay-file-accept':
            // Relay Fallback - Response from receiver
            handleRelayFileAccept(msg.sender, msg.accepted);
            break;
            
        case 'relay-chunk':
            // Relay Fallback - Chunk data
            handleRelayChunk(msg.sender, msg);
            break;
            
        case 'relay-cancel':
            // Relay Fallback - Cancelled transfer
            handleRelayCancel();
            break;
            
        case 'clipboard-text':
            // Clipboard share received
            handleClipboardShare(msg.sender, msg.text);
            break;
    }
}

// QR Code and Networks Panel
function generateConnectionQR(ips, port, primaryIP) {
    // Generate primary URL
    const primaryUrl = `http://${primaryIP}:${port}`;
    el.shareLinkInput.value = primaryUrl;
    
    // Create QR
    try {
        const qr = qrcode(0, 'M');
        qr.addData(primaryUrl);
        qr.make();
        el.qrContainer.innerHTML = qr.createImgTag(5, 10);
    } catch (e) {
        console.error('Failed to generate QR:', e);
        el.qrContainer.innerHTML = `<p style="color: var(--text-secondary); padding: 2rem;">QR generation unavailable</p>`;
    }
    
    // Render list of alternative local networks
    el.localNetworksIps.innerHTML = '';
    if (ips && ips.length > 0) {
        ips.forEach(ip => {
            const url = `http://${ip}:${port}`;
            const li = document.createElement('li');
            li.innerHTML = `
                <span>${ip}</span>
                <button class="btn btn-text" onclick="navigator.clipboard.writeText('${url}')" style="padding: 2px 6px; font-size: 0.75rem;">
                    Copy Link
                </button>
            `;
            el.localNetworksIps.appendChild(li);
        });
    } else {
        el.localNetworksIps.innerHTML = `<li>No external network addresses found.</li>`;
    }
}

// Clear all peers
function clearPeers() {
    peers.clear();
    renderPeers();
}

// Update local peer map
function updatePeersList(newPeers) {
    const oldKeys = Array.from(peers.keys());
    const newKeys = newPeers.map(p => p.id);
    
    // Check if new peers joined (to play join chime)
    const joined = newKeys.filter(k => !oldKeys.includes(k));
    if (joined.length > 0 && oldKeys.length > 0) {
        AudioFeedback.playJoin();
    }
    
    peers.clear();
    newPeers.forEach(p => {
        peers.set(p.id, p);
    });
    
    renderPeers();
    updateTextTargetDropdown();
}

// Render radar peers
function renderPeers() {
    el.peersLayer.innerHTML = '';
    
    if (peers.size === 0) {
        el.radarTitle.textContent = 'Looking for nearby devices...';
        return;
    }
    
    el.radarTitle.textContent = 'Devices found nearby';
    
    const peerArray = Array.from(peers.values());
    const count = peerArray.length;
    
    peerArray.forEach((peer, index) => {
        // Compute circular layout coordinates
        const radarRadius = 100; // max size in percentage coordinates
        let distanceMultiplier = 0.55; // default orbit
        
        // Stagger distance if multiple peers to avoid overlaps
        if (count > 1) {
            distanceMultiplier = index % 2 === 0 ? 0.42 : 0.75;
        }
        
        // Angles distributed evenly
        const angle = (index * 2 * Math.PI) / count - (Math.PI / 2);
        
        const x = 50 + (distanceMultiplier * 50 * Math.cos(angle));
        const y = 50 + (distanceMultiplier * 50 * Math.sin(angle));
        
        const peerNode = document.createElement('div');
        peerNode.className = 'peer-node';
        peerNode.style.left = `${x}%`;
        peerNode.style.top = `${y}%`;
        peerNode.setAttribute('data-id', peer.id);
        
        let deviceIcon = 'fa-laptop';
        if (peer.device.type === 'mobile') deviceIcon = 'fa-mobile-screen-button';
        if (peer.device.type === 'tablet') deviceIcon = 'fa-tablet-screen-button';
        
        peerNode.innerHTML = `
            <div class="peer-avatar" style="background: ${peer.color}; color: #ffffff;">
                <i class="fa-solid ${deviceIcon}"></i>
                <div class="peer-pulse" style="color: ${peer.color};"></div>
            </div>
            <div class="peer-name-label">${peer.name}</div>
        `;
        
        // Listeners for triggers
        peerNode.addEventListener('click', () => initiateFileShare(peer.id));
        
        el.peersLayer.appendChild(peerNode);
    });
}

// Update drop down for text share
function updateTextTargetDropdown() {
    const savedVal = el.textTargetPeer.value;
    el.textTargetPeer.innerHTML = '<option value="">Select target device...</option>';
    
    peers.forEach(peer => {
        const option = document.createElement('option');
        option.value = peer.id;
        option.textContent = `${peer.name} (${peer.device.browser} on ${peer.device.os})`;
        el.textTargetPeer.appendChild(option);
    });
    
    // Restore selection if target still exists
    if (peers.has(savedVal)) {
        el.textTargetPeer.value = savedVal;
    }
}

// Setup global events
function setupEventListeners() {
    // Actions triggers
    el.btnShowQr.addEventListener('click', () => showModal(el.qrModal));
    el.btnCloseQr.addEventListener('click', () => hideModal(el.qrModal));
    
    el.btnTextShare.addEventListener('click', () => {
        el.textToShare.value = '';
        el.btnSendTextConfirm.disabled = true;
        showModal(el.textShareModal);
    });
    el.btnCloseTextShare.addEventListener('click', () => hideModal(el.textShareModal));
    el.btnCancelText.addEventListener('click', () => hideModal(el.textShareModal));
    
    // Enable/disable text send button based on checks
    const checkTextForm = () => {
        el.btnSendTextConfirm.disabled = !(el.textTargetPeer.value && el.textToShare.value.trim());
    };
    el.textTargetPeer.addEventListener('change', checkTextForm);
    el.textToShare.addEventListener('input', checkTextForm);
    
    el.btnSendTextConfirm.addEventListener('click', sendClipboardText);
    
    // Copy button handlers
    el.btnCopyLink.addEventListener('click', () => {
        navigator.clipboard.writeText(el.shareLinkInput.value).then(() => {
            const originalIcon = el.btnCopyLink.innerHTML;
            el.btnCopyLink.innerHTML = '<i class="fa-solid fa-check" style="color: var(--success-color)"></i>';
            setTimeout(() => { el.btnCopyLink.innerHTML = originalIcon; }, 2000);
        });
    });
    
    el.btnCopyReceivedText.addEventListener('click', () => {
        navigator.clipboard.writeText(el.textReceivedContent.textContent).then(() => {
            const originalText = el.btnCopyReceivedText.innerHTML;
            el.btnCopyReceivedText.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
            setTimeout(() => { el.btnCopyReceivedText.innerHTML = originalText; }, 2000);
        });
    });
    
    el.btnCloseTextReceived.addEventListener('click', () => hideModal(el.textReceivedModal));
    el.btnCloseTextReceivedFooter.addEventListener('click', () => hideModal(el.textReceivedModal));
    
    // Transfer cancels
    el.btnCancelTransfer.addEventListener('click', cancelActiveTransfer);
    
    // Preview closures
    el.btnClosePreview.addEventListener('click', () => hideModal(el.previewModal));
    el.btnPreviewDone.addEventListener('click', () => hideModal(el.previewModal));
    
    // File inputs triggers
    el.fileInput.addEventListener('change', handleFileSelected);

    // Premium File Selector Events
    el.btnCloseFileSelect.addEventListener('click', () => hideModal(el.fileSelectModal));
    el.btnCancelFileSelect.addEventListener('click', () => hideModal(el.fileSelectModal));
    el.btnSendFilesConfirm.addEventListener('click', startQueueSending);
    
    el.fileDropZone.addEventListener('click', () => {
        el.fileInput.removeAttribute('accept');
        el.fileInput.click();
    });
    
    // Shortcuts categories triggers
    el.catImages.onclick = (e) => {
        e.stopPropagation();
        el.fileInput.setAttribute('accept', 'image/*');
        el.fileInput.click();
    };
    el.catVideos.onclick = (e) => {
        e.stopPropagation();
        el.fileInput.setAttribute('accept', 'video/*');
        el.fileInput.click();
    };
    el.catAudio.onclick = (e) => {
        e.stopPropagation();
        el.fileInput.setAttribute('accept', 'audio/*');
        el.fileInput.click();
    };
    el.catDocs.onclick = (e) => {
        e.stopPropagation();
        el.fileInput.setAttribute('accept', '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt');
        el.fileInput.click();
    };
    
    // Drag & drop handlers
    el.fileDropZone.ondragover = el.fileDropZone.ondragenter = (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.fileDropZone.classList.add('dragover');
    };
    
    el.fileDropZone.ondragleave = el.fileDropZone.ondragend = (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.fileDropZone.classList.remove('dragover');
    };
    
    el.fileDropZone.ondrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.fileDropZone.classList.remove('dragover');
        
        const files = e.dataTransfer.files;
        if (files.length > 0 && currentRecipientPeerId) {
            for (let i = 0; i < files.length; i++) {
                selectedFilesQueue.push(files[i]);
            }
            renderFilesQueue();
        }
    };

    // Rename Modal Listeners
    el.profileCardRename.addEventListener('click', () => {
        el.inputDeviceName.value = myName;
        showModal(el.renameModal);
    });
    
    el.btnCloseRename.addEventListener('click', () => hideModal(el.renameModal));
    el.btnCancelRename.addEventListener('click', () => hideModal(el.renameModal));
    el.btnSaveRename.addEventListener('click', saveCustomDeviceName);
    
    // History Modal Listeners
    el.btnShowHistory.addEventListener('click', () => {
        renderHistoryList();
        showModal(el.historyModal);
    });
    
    el.btnCloseHistory.addEventListener('click', () => hideModal(el.historyModal));
    el.btnClearHistory.addEventListener('click', clearSharingHistory);
}

// Modal helper controls
function showModal(modal) {
    modal.classList.add('active');
}

function hideModal(modal) {
    modal.classList.remove('active');
}

// Toast and Trust Timeout Helpers
function showToast(title, desc, type = 'success') {
    if (!el.toastContainer) return;
    
    const toast = document.createElement('div');
    toast.className = 'toast';
    
    let iconClass = 'fa-check';
    if (type === 'error') iconClass = 'fa-triangle-exclamation';
    if (type === 'info') iconClass = 'fa-circle-info';
    
    toast.innerHTML = `
        <div class="toast-icon ${type}">
            <i class="fa-solid ${iconClass}"></i>
        </div>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-desc">${desc}</div>
        </div>
    `;
    
    el.toastContainer.appendChild(toast);
    
    // Force reflow
    toast.offsetHeight;
    
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            toast.remove();
        }, 400);
    }, 4000);
}

function resetAutoAcceptTimeout() {
    if (autoAcceptTimeout) {
        clearTimeout(autoAcceptTimeout);
    }
    autoAcceptTimeout = setTimeout(() => {
        autoAcceptPeerId = null;
        autoAcceptTimeout = null;
        console.log('Auto-accept session trust expired.');
    }, 12000); // 12 seconds inactivity timeout
}

// Clipboard Text Sharing Functionality
function sendClipboardText() {
    const targetId = el.textTargetPeer.value;
    const text = el.textToShare.value.trim();
    
    if (!targetId || !text) return;
    
    socket.send(JSON.stringify({
        type: 'clipboard-text',
        target: targetId,
        text: text
    }));
    
    hideModal(el.textShareModal);
    
    // Play sound indicators
    AudioFeedback.playSuccess();
}

function handleClipboardShare(senderId, text) {
    const peer = peers.get(senderId);
    const senderName = peer ? peer.name : 'Unknown Device';
    
    el.textReceivedSender.textContent = `From ${senderName}`;
    el.textReceivedContent.textContent = text;
    
    AudioFeedback.playRequest();
    showModal(el.textReceivedModal);
}

// Initializing WebRTC and file selection
let currentRecipientPeerId = null;
let selectedFilesQueue = [];
let sendingQueue = [];

function initiateFileShare(peerId) {
    if (activeTransfer.peerId) {
        alert('Another file transfer is already active!');
        return;
    }
    
    currentRecipientPeerId = peerId;
    selectedFilesQueue = [];
    
    const peer = peers.get(peerId);
    if (!peer) return;
    
    el.fileSelectTargetName.textContent = peer.name;
    renderFilesQueue();
    showModal(el.fileSelectModal);
}

// Render selected file queue preview list
function renderFilesQueue() {
    el.queueList.innerHTML = '';
    
    if (selectedFilesQueue.length === 0) {
        el.selectedFilesQueue.style.display = 'none';
        el.btnSendFilesConfirm.disabled = true;
        return;
    }
    
    el.selectedFilesQueue.style.display = 'block';
    el.btnSendFilesConfirm.disabled = false;
    
    selectedFilesQueue.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'queue-item';
        
        item.innerHTML = `
            <div class="queue-item-icon">${getFileIconHTML(file.type || '')}</div>
            <div class="queue-item-meta">
                <div class="queue-item-name">${file.name}</div>
                <div class="queue-item-size">${formatBytes(file.size)}</div>
            </div>
            <button class="queue-item-remove" data-index="${index}"><i class="fa-solid fa-trash-can"></i></button>
        `;
        
        // Remove individual file from list
        item.querySelector('.queue-item-remove').onclick = (e) => {
            e.stopPropagation();
            selectedFilesQueue.splice(index, 1);
            renderFilesQueue();
        };
        
        el.queueList.appendChild(item);
    });
}

// File selected change handler
function handleFileSelected(event) {
    const files = event.target.files;
    if (files.length === 0 || !currentRecipientPeerId) return;
    
    for (let i = 0; i < files.length; i++) {
        selectedFilesQueue.push(files[i]);
    }
    
    renderFilesQueue();
    el.fileInput.value = ''; // Reset input to capture same selection again
}

// Start sequential transmissions of files
function startQueueSending() {
    if (selectedFilesQueue.length === 0) return;
    
    sendingQueue = [...selectedFilesQueue];
    currentQueueLength = sendingQueue.length;
    currentQueueIndex = 0;
    selectedFilesQueue = [];
    hideModal(el.fileSelectModal);
    
    sendNextFileInQueue();
}

function sendNextFileInQueue() {
    if (sendingQueue.length === 0) {
        resetActiveTransfer();
        return;
    }
    
    const file = sendingQueue.shift();
    const peer = peers.get(currentRecipientPeerId);
    if (!peer) {
        alert('Recipient device has disconnected!');
        sendingQueue = [];
        resetActiveTransfer();
        return;
    }
    
    // Initialize transfer state for this specific file
    activeTransfer = {
        peerId: currentRecipientPeerId,
        peerName: peer.name,
        type: 'send',
        mode: 'webrtc',
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || 'application/octet-stream',
        chunks: [],
        chunksReceived: 0,
        totalChunks: Math.ceil(file.size / CHUNK_SIZE),
        bytesTransferred: 0,
        startTime: Date.now(),
        isCancelled: false,
        file: file,
        queueIndex: currentQueueIndex,
        queueLength: currentQueueLength
    };
    
    currentQueueIndex++; // Increment for next file in queue
    
    // Display connecting progress dialog
    el.progressTitle.textContent = `Connecting to ${peer.name}...`;
    el.progressFileInfo.textContent = `${file.name} (${formatBytes(file.size)})`;
    el.transferMode.textContent = 'Connecting via WebRTC...';
    el.transferMode.style.background = 'rgba(245, 158, 11, 0.15)';
    el.transferMode.style.borderColor = 'rgba(245, 158, 11, 0.2)';
    el.transferMode.style.color = 'var(--warning-color)';
    updateProgressUI(0);
    showModal(el.progressModal);
    
    // Setup a fallback timeout: if P2P cannot connect in 5 seconds, switch to WebSocket
    connectionTimeout = setTimeout(() => {
        console.warn('WebRTC connection timed out. Falling back to WebSocket Server Relay.');
        switchToWebSocketFallbackSend();
    }, WEBRTC_TIMEOUT);
    
    // Start WebRTC connection setup
    prepareWebRtcConnection(currentRecipientPeerId, true);
}

// Setup RTCPeerConnection
function prepareWebRtcConnection(peerId, isInitiator) {
    // Check if configuration exists, otherwise close old connection
    if (peerConnections.has(peerId)) {
        closePeerConnection(peerId);
    }
    
    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19002' },
            { urls: 'stun:stun1.l.google.com:19002' }
        ]
    });
    
    peerConnections.set(peerId, pc);
    pendingIceCandidates.set(peerId, []);
    
    // Handle ICE candidates
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.send(JSON.stringify({
                type: 'signal',
                target: peerId,
                signal: { type: 'candidate', candidate: event.candidate }
            }));
        }
    };
    
    pc.onconnectionstatechange = () => {
        console.log(`WebRTC Connection State: ${pc.connectionState}`);
        if (pc.connectionState === 'connected') {
            if (connectionTimeout) {
                clearTimeout(connectionTimeout);
                connectionTimeout = null;
            }
            if (activeTransfer.type === 'send' && activeTransfer.peerId === peerId) {
                el.transferMode.textContent = 'WebRTC P2P Direct';
                el.transferMode.style.background = 'rgba(16, 185, 129, 0.15)';
                el.transferMode.style.borderColor = 'rgba(16, 185, 129, 0.2)';
                el.transferMode.style.color = 'var(--success-color)';
            }
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            handleWebRtcFailure(peerId);
        }
    };
    
    if (isInitiator) {
        // Create Data Channel
        const dc = pc.createDataChannel('fileTransfer', {
            ordered: true,
            // Allow setting low watermark thresholds
        });
        setupDataChannel(peerId, dc);
        
        // Create offer
        pc.createOffer()
            .then(offer => pc.setLocalDescription(offer))
            .then(() => {
                socket.send(JSON.stringify({
                    type: 'signal',
                    target: peerId,
                    signal: pc.localDescription
                }));
            })
            .catch(err => {
                console.error('Error creating offer:', err);
                handleWebRtcFailure(peerId);
            });
    } else {
        // For receiver, setup listener for incoming channels
        pc.ondatachannel = (event) => {
            setupDataChannel(peerId, event.channel);
        };
    }
}

function setupDataChannel(peerId, dc) {
    dataChannels.set(peerId, dc);
    dc.binaryType = 'arraybuffer';
    
    dc.onopen = () => {
        console.log(`Data Channel opened with peer: ${peerId}`);
        
        // If we are sending, start negotiating file info
        if (activeTransfer.type === 'send' && activeTransfer.peerId === peerId) {
            if (connectionTimeout) {
                clearTimeout(connectionTimeout);
                connectionTimeout = null;
            }
            // Send file metadata information first
            dc.send(JSON.stringify({
                type: 'file-metadata',
                fileName: activeTransfer.fileName,
                fileSize: activeTransfer.fileSize,
                fileType: activeTransfer.fileType,
                queueIndex: activeTransfer.queueIndex,
                queueLength: activeTransfer.queueLength
            }));
        }
    };
    
    dc.onclose = () => {
        console.log(`Data Channel closed for peer: ${peerId}`);
        handleWebRtcFailure(peerId);
    };
    
    dc.onmessage = (event) => {
        if (typeof event.data === 'string') {
            // Control Message
            try {
                const msg = JSON.parse(event.data);
                handleControlMessage(peerId, msg);
            } catch (e) {
                console.error('Failed to parse DataChannel message:', e);
            }
        } else {
            // Binary Chunk Received
            handleBinaryChunk(event.data);
        }
    };
}

// Close individual peer connection
function closePeerConnection(peerId) {
    if (dataChannels.has(peerId)) {
        try { dataChannels.get(peerId).close(); } catch (e) {}
        dataChannels.delete(peerId);
    }
    if (peerConnections.has(peerId)) {
        try { peerConnections.get(peerId).close(); } catch (e) {}
        peerConnections.delete(peerId);
    }
    pendingIceCandidates.delete(peerId);
}

// Handle signaling message exchange
function handleWebRtcSignal(senderId, signal) {
    let pc = peerConnections.get(senderId);
    
    if (!pc) {
        // Receiver setup connection
        prepareWebRtcConnection(senderId, false);
        pc = peerConnections.get(senderId);
    }
    
    if (signal.type === 'offer') {
        pc.setRemoteDescription(new RTCSessionDescription(signal))
            .then(() => pc.createAnswer())
            .then(answer => pc.setLocalDescription(answer))
            .then(() => {
                socket.send(JSON.stringify({
                    type: 'signal',
                    target: senderId,
                    signal: pc.localDescription
                }));
                // Process any queued ICE candidates
                const queued = pendingIceCandidates.get(senderId) || [];
                queued.forEach(cand => {
                    pc.addIceCandidate(new RTCIceCandidate(cand)).catch(e => console.error(e));
                });
                pendingIceCandidates.set(senderId, []);
            })
            .catch(err => console.error('Error answering offer:', err));
            
    } else if (signal.type === 'answer') {
        pc.setRemoteDescription(new RTCSessionDescription(signal))
            .then(() => {
                const queued = pendingIceCandidates.get(senderId) || [];
                queued.forEach(cand => {
                    pc.addIceCandidate(new RTCIceCandidate(cand)).catch(e => console.error(e));
                });
                pendingIceCandidates.set(senderId, []);
            })
            .catch(err => console.error('Error setting remote answer:', err));
            
    } else if (signal.type === 'candidate' && signal.candidate) {
        if (pc.remoteDescription) {
            pc.addIceCandidate(new RTCIceCandidate(signal.candidate))
                .catch(err => console.error('Error adding ICE candidate:', err));
        } else {
            // Queue candidates
            const queued = pendingIceCandidates.get(senderId) || [];
            queued.push(signal.candidate);
            pendingIceCandidates.set(senderId, queued);
        }
    }
}

// WebRTC state failure transitions
function handleWebRtcFailure(peerId) {
    if (activeTransfer.peerId === peerId && activeTransfer.mode === 'webrtc') {
        console.warn('Direct WebRTC failure detected. Switching transfer to WS Server fallback.');
        if (activeTransfer.type === 'send') {
            switchToWebSocketFallbackSend();
        } else {
            // For receiver, wait for server to relay chunks, the server handles state updates
            activeTransfer.mode = 'websocket';
            el.transferMode.textContent = 'Server Relay Fallback';
            el.transferMode.style.background = 'rgba(59, 130, 246, 0.15)';
            el.transferMode.style.borderColor = 'rgba(59, 130, 246, 0.2)';
            el.transferMode.style.color = 'var(--secondary-color)';
        }
    }
}

// Handle control signals inside WebRTC DataChannel
function handleControlMessage(peerId, msg) {
    switch (msg.type) {
        case 'file-metadata':
            // Received file info metadata
            const peer = peers.get(peerId);
            const senderName = peer ? peer.name : 'Unknown Device';
            
            activeTransfer = {
                peerId: peerId,
                peerName: senderName,
                type: 'receive',
                mode: 'webrtc',
                fileName: msg.fileName,
                fileSize: msg.fileSize,
                fileType: msg.fileType,
                chunks: [],
                chunksReceived: 0,
                totalChunks: Math.ceil(msg.fileSize / CHUNK_SIZE),
                bytesTransferred: 0,
                startTime: 0,
                isCancelled: false,
                queueIndex: msg.queueIndex !== undefined ? msg.queueIndex : 0,
                queueLength: msg.queueLength !== undefined ? msg.queueLength : 1
            };
            
            // Check if we should auto-accept this queued file transfer
            const shouldAutoAccept = (
                autoAcceptPeerId === peerId &&
                msg.queueIndex > 0
            );
            
            if (shouldAutoAccept) {
                // Auto-accept: send accept signal and start receiving UI state immediately
                activeTransfer.startTime = Date.now();
                
                // Show progress modal
                el.progressTitle.textContent = `Receiving file (${msg.queueIndex + 1}/${msg.queueLength})...`;
                el.progressFileInfo.textContent = `${msg.fileName} (${formatBytes(msg.fileSize)})`;
                el.transferMode.textContent = 'WebRTC P2P Direct';
                el.transferMode.style.background = 'rgba(16, 185, 129, 0.15)';
                el.transferMode.style.borderColor = 'rgba(16, 185, 129, 0.2)';
                el.transferMode.style.color = 'var(--success-color)';
                updateProgressUI(0);
                showModal(el.progressModal);
                
                // Send accept message back over data channel
                const dc = dataChannels.get(peerId);
                if (dc && dc.readyState === 'open') {
                    dc.send(JSON.stringify({ type: 'file-accept', accepted: true }));
                }
                
                resetAutoAcceptTimeout();
            } else {
                // Reset trust session if a new queue/single file is sent manually
                if (msg.queueIndex === 0 || msg.queueIndex === undefined) {
                    autoAcceptPeerId = null;
                }
                
                // Show prompt
                el.reqSenderName.textContent = senderName;
                el.reqSenderAvatar.style.background = peer ? peer.color : 'var(--primary-gradient)';
                el.reqFileName.textContent = msg.queueLength > 1 
                    ? `${msg.fileName} (and ${msg.queueLength - 1} more files)`
                    : msg.fileName;
                el.reqFileSize.textContent = formatBytes(msg.fileSize);
                
                // Set type icon
                el.reqFileIcon.innerHTML = getFileIconHTML(msg.fileType);
                
                AudioFeedback.playRequest();
                showModal(el.receiveRequestModal);
            }
            break;
            
        case 'file-accept':
            if (activeTransfer.type === 'send' && activeTransfer.peerId === peerId) {
                if (msg.accepted) {
                    // Start transmitting binary chunks
                    el.progressTitle.textContent = `Sending file...`;
                    activeTransfer.startTime = Date.now();
                    startSendingWebRtcChunks();
                } else {
                    hideModal(el.progressModal);
                    alert(`${activeTransfer.peerName} declined the file transfer.`);
                    addHistoryRecord('sent', activeTransfer.fileName, activeTransfer.fileSize, activeTransfer.fileType, 'Declined');
                    resetActiveTransfer();
                    AudioFeedback.playError();
                }
            }
            break;
            
        case 'file-cancel':
            handleTransferCancelledByPeer();
            break;
    }
}

// File transmission - WebRTC Chunking
function startSendingWebRtcChunks() {
    const dc = dataChannels.get(activeTransfer.peerId);
    if (!dc || dc.readyState !== 'open') {
        console.error('Data Channel is not open!');
        switchToWebSocketFallbackSend();
        return;
    }
    
    const file = activeTransfer.file;
    let offset = 0;
    
    const readNextSlice = () => {
        if (activeTransfer.isCancelled) return;
        
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const reader = new FileReader();
        
        reader.onload = (e) => {
            if (activeTransfer.isCancelled) return;
            
            dc.send(e.target.result);
            offset += e.target.result.byteLength;
            activeTransfer.bytesTransferred = offset;
            
            updateProgressStats();
            
            if (offset < file.size) {
                // Throttling / Flow control for bufferedAmount
                if (dc.bufferedAmount > 256 * 1024) { // 256KB cap
                    dc.onbufferedamountlow = () => {
                        dc.onbufferedamountlow = null;
                        readNextSlice();
                    };
                } else {
                    // Schedule next slice in next loop event
                    setTimeout(readNextSlice, 1);
                }
            } else {
                // Completed!
                setTimeout(concludeTransferSuccess, 200);
            }
        };
        
        reader.readAsArrayBuffer(slice);
    };
    
    readNextSlice();
}

// File receiving - WebRTC Chunk assembler
function handleBinaryChunk(arrayBuffer) {
    if (activeTransfer.isCancelled || activeTransfer.type !== 'receive') return;
    
    // For first chunk, start timing
    if (activeTransfer.bytesTransferred === 0) {
        activeTransfer.startTime = Date.now();
        el.progressTitle.textContent = `Receiving file...`;
        el.progressFileInfo.textContent = `${activeTransfer.fileName} (${formatBytes(activeTransfer.fileSize)})`;
        showModal(el.progressModal);
    }
    
    activeTransfer.chunks.push(arrayBuffer);
    activeTransfer.bytesTransferred += arrayBuffer.byteLength;
    activeTransfer.chunksReceived++;
    
    updateProgressStats();
    
    if (activeTransfer.bytesTransferred >= activeTransfer.fileSize) {
        // Complete Assembly
        const fullBlob = new Blob(activeTransfer.chunks, { type: activeTransfer.fileType });
        concludeTransferSuccess(fullBlob);
    }
}

// WebSocket Fallback Relaying
function switchToWebSocketFallbackSend() {
    if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
    }
    
    if (activeTransfer.isCancelled || activeTransfer.mode === 'websocket') return;
    
    activeTransfer.mode = 'websocket';
    el.transferMode.textContent = 'Server Relay Fallback';
    el.transferMode.style.background = 'rgba(59, 130, 246, 0.15)';
    el.transferMode.style.borderColor = 'rgba(59, 130, 246, 0.2)';
    el.transferMode.style.color = 'var(--secondary-color)';
    
    console.log('Sending file metadata via WebSocket server...');
    
    // Send file metadata to server to forward
    socket.send(JSON.stringify({
        type: 'relay-file-metadata',
        target: activeTransfer.peerId,
        fileName: activeTransfer.fileName,
        fileSize: activeTransfer.fileSize,
        fileType: activeTransfer.fileType,
        queueIndex: activeTransfer.queueIndex,
        queueLength: activeTransfer.queueLength
    }));
}

// WS Fallback - Incoming Meta
function handleRelayFileMetadata(senderId, msg) {
    if (activeTransfer.peerId) {
        // Busy - Decline automatically
        socket.send(JSON.stringify({
            type: 'relay-file-accept',
            target: senderId,
            accepted: false
        }));
        return;
    }
    
    const peer = peers.get(senderId);
    const senderName = peer ? peer.name : 'Unknown Device';
    
    activeTransfer = {
        peerId: senderId,
        peerName: senderName,
        type: 'receive',
        mode: 'websocket',
        fileName: msg.fileName,
        fileSize: msg.fileSize,
        fileType: msg.fileType,
        chunks: [],
        chunksReceived: 0,
        totalChunks: Math.ceil(msg.fileSize / CHUNK_SIZE),
        bytesTransferred: 0,
        startTime: 0,
        isCancelled: false,
        queueIndex: msg.queueIndex !== undefined ? msg.queueIndex : 0,
        queueLength: msg.queueLength !== undefined ? msg.queueLength : 1
    };
    
    // Check if we should auto-accept this queued file transfer
    const shouldAutoAccept = (
        autoAcceptPeerId === senderId &&
        msg.queueIndex > 0
    );
    
    if (shouldAutoAccept) {
        // Relayed fallback accept
        socket.send(JSON.stringify({
            type: 'relay-file-accept',
            target: activeTransfer.peerId,
            accepted: true
        }));
        
        activeTransfer.startTime = Date.now();
        el.progressTitle.textContent = `Relaying file (${msg.queueIndex + 1}/${msg.queueLength})...`;
        el.progressFileInfo.textContent = `${activeTransfer.fileName} (${formatBytes(activeTransfer.fileSize)})`;
        el.transferMode.textContent = 'Server Relay Fallback';
        el.transferMode.style.background = 'rgba(59, 130, 246, 0.15)';
        el.transferMode.style.borderColor = 'rgba(59, 130, 246, 0.2)';
        el.transferMode.style.color = 'var(--secondary-color)';
        updateProgressUI(0);
        showModal(el.progressModal);
        
        resetAutoAcceptTimeout();
    } else {
        // Reset trust session if a new queue/single file is sent manually
        if (msg.queueIndex === 0 || msg.queueIndex === undefined) {
            autoAcceptPeerId = null;
        }
        
        // Set interface prompt options
        el.reqSenderName.textContent = senderName;
        el.reqSenderAvatar.style.background = peer ? peer.color : 'var(--primary-gradient)';
        el.reqFileName.textContent = msg.queueLength > 1 
            ? `${msg.fileName} (and ${msg.queueLength - 1} more files)`
            : msg.fileName;
        el.reqFileSize.textContent = formatBytes(msg.fileSize);
        el.reqFileIcon.innerHTML = getFileIconHTML(msg.fileType);
        
        AudioFeedback.playRequest();
        showModal(el.receiveRequestModal);
    }
}

// WS Fallback - Sender gets accept notification
function handleRelayFileAccept(senderId, accepted) {
    if (activeTransfer.type === 'send' && activeTransfer.peerId === senderId) {
        if (accepted) {
            el.progressTitle.textContent = `Relaying file...`;
            activeTransfer.startTime = Date.now();
            startSendingRelayChunks();
        } else {
            hideModal(el.progressModal);
            alert(`${activeTransfer.peerName} declined the file transfer.`);
            addHistoryRecord('sent', activeTransfer.fileName, activeTransfer.fileSize, activeTransfer.fileType, 'Declined');
            resetActiveTransfer();
            AudioFeedback.playError();
        }
    }
}

// WS Fallback - Send chunks as base64 stringified data
function startSendingRelayChunks() {
    const file = activeTransfer.file;
    let offset = 0;
    
    const readNextSlice = () => {
        if (activeTransfer.isCancelled || activeTransfer.mode !== 'websocket') return;
        
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const reader = new FileReader();
        
        reader.onload = (e) => {
            if (activeTransfer.isCancelled) return;
            
            // Read as dataurl to extract base64 directly
            const dataUrl = reader.result;
            const base64 = dataUrl.split(',')[1];
            
            socket.send(JSON.stringify({
                type: 'relay-chunk',
                target: activeTransfer.peerId,
                chunk: base64,
                chunkSize: slice.size
            }));
            
            offset += slice.size;
            activeTransfer.bytesTransferred = offset;
            updateProgressStats();
            
            if (offset < file.size) {
                // Short timeout to yield UI thread and prevent WS pipeline blocking
                setTimeout(readNextSlice, 25);
            } else {
                setTimeout(concludeTransferSuccess, 200);
            }
        };
        
        reader.readAsDataURL(slice);
    };
    
    readNextSlice();
}

// WS Fallback - Receiver processes base64 string back to binary buffer
function handleRelayChunk(senderId, msg) {
    if (activeTransfer.isCancelled || activeTransfer.type !== 'receive' || activeTransfer.peerId !== senderId) return;
    
    if (activeTransfer.bytesTransferred === 0) {
        activeTransfer.startTime = Date.now();
        el.progressTitle.textContent = `Relaying file...`;
        el.progressFileInfo.textContent = `${activeTransfer.fileName} (${formatBytes(activeTransfer.fileSize)})`;
        showModal(el.progressModal);
    }
    
    // Decode base64 to binary ArrayBuffer
    const binaryString = atob(msg.chunk);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    
    activeTransfer.chunks.push(bytes.buffer);
    activeTransfer.bytesTransferred += msg.chunkSize;
    activeTransfer.chunksReceived++;
    
    updateProgressStats();
    
    if (activeTransfer.bytesTransferred >= activeTransfer.fileSize) {
        const fullBlob = new Blob(activeTransfer.chunks, { type: activeTransfer.fileType });
        concludeTransferSuccess(fullBlob);
    }
}

// Cancel active transfer (by UI action click)
function cancelActiveTransfer() {
    activeTransfer.isCancelled = true;
    
    // Add history record for cancellation
    if (activeTransfer.peerId && activeTransfer.fileName) {
        addHistoryRecord(activeTransfer.type === 'send' ? 'sent' : 'received', activeTransfer.fileName, activeTransfer.fileSize, activeTransfer.fileType, 'Cancelled');
    }
    
    // Notify peer
    if (activeTransfer.peerId) {
        if (activeTransfer.mode === 'webrtc') {
            const dc = dataChannels.get(activeTransfer.peerId);
            if (dc && dc.readyState === 'open') {
                try {
                    dc.send(JSON.stringify({ type: 'file-cancel' }));
                } catch (e) {}
            }
        } else {
            // Relayed fallback cancel
            socket.send(JSON.stringify({
                type: 'relay-cancel',
                target: activeTransfer.peerId
            }));
        }
    }
    
    closePeerConnection(activeTransfer.peerId);
    hideModal(el.progressModal);
    resetActiveTransfer();
    AudioFeedback.playError();
}

function handleTransferCancelledByPeer() {
    hideModal(el.progressModal);
    alert(`Transfer cancelled by ${activeTransfer.peerName}`);
    
    // Add history record for peer cancellation
    if (activeTransfer.peerId && activeTransfer.fileName) {
        addHistoryRecord(activeTransfer.type === 'send' ? 'sent' : 'received', activeTransfer.fileName, activeTransfer.fileSize, activeTransfer.fileType, 'Cancelled');
    }
    
    closePeerConnection(activeTransfer.peerId);
    resetActiveTransfer();
    AudioFeedback.playError();
}

function handleRelayCancel() {
    handleTransferCancelledByPeer();
}

// Prompt Confirm Actions (Receive Modal Accept/Decline)
el.btnAcceptFile.onclick = () => {
    hideModal(el.receiveRequestModal);
    
    // Set auto-accept peer ID for subsequent files in this queue
    if (activeTransfer.queueLength > 1) {
        autoAcceptPeerId = activeTransfer.peerId;
        resetAutoAcceptTimeout();
    }
    
    if (activeTransfer.mode === 'webrtc') {
        const dc = dataChannels.get(activeTransfer.peerId);
        if (dc && dc.readyState === 'open') {
            dc.send(JSON.stringify({ type: 'file-accept', accepted: true }));
            // Set up receiving state UI
            activeTransfer.startTime = Date.now();
            el.progressTitle.textContent = activeTransfer.queueLength > 1
                ? `Receiving file (${activeTransfer.queueIndex + 1}/${activeTransfer.queueLength})...`
                : `Receiving file...`;
            el.progressFileInfo.textContent = `${activeTransfer.fileName} (${formatBytes(activeTransfer.fileSize)})`;
            el.transferMode.textContent = 'WebRTC P2P Direct';
            el.transferMode.style.background = 'rgba(16, 185, 129, 0.15)';
            el.transferMode.style.borderColor = 'rgba(16, 185, 129, 0.2)';
            el.transferMode.style.color = 'var(--success-color)';
            updateProgressUI(0);
            showModal(el.progressModal);
        } else {
            console.warn('Accept clicked but WebRTC channel was lost. Trying Relay fallback.');
            // Let the fallback process metadata relay if available
        }
    } else {
        // Relayed fallback accept
        socket.send(JSON.stringify({
            type: 'relay-file-accept',
            target: activeTransfer.peerId,
            accepted: true
        }));
        
        activeTransfer.startTime = Date.now();
        el.progressTitle.textContent = activeTransfer.queueLength > 1
            ? `Relaying file (${activeTransfer.queueIndex + 1}/${activeTransfer.queueLength})...`
            : `Relaying file...`;
        el.progressFileInfo.textContent = `${activeTransfer.fileName} (${formatBytes(activeTransfer.fileSize)})`;
        el.transferMode.textContent = 'Server Relay Fallback';
        el.transferMode.style.background = 'rgba(59, 130, 246, 0.15)';
        el.transferMode.style.borderColor = 'rgba(59, 130, 246, 0.2)';
        el.transferMode.style.color = 'var(--secondary-color)';
        updateProgressUI(0);
        showModal(el.progressModal);
    }
};

el.btnDeclineFile.onclick = () => {
    hideModal(el.receiveRequestModal);
    
    // Log decline to history
    if (activeTransfer.peerId && activeTransfer.fileName) {
        addHistoryRecord('received', activeTransfer.fileName, activeTransfer.fileSize, activeTransfer.fileType, 'Declined');
    }
    
    if (activeTransfer.mode === 'webrtc') {
        const dc = dataChannels.get(activeTransfer.peerId);
        if (dc && dc.readyState === 'open') {
            try { dc.send(JSON.stringify({ type: 'file-accept', accepted: false })); } catch (e) {}
        }
    } else {
        socket.send(JSON.stringify({
            type: 'relay-file-accept',
            target: activeTransfer.peerId,
            accepted: false
        }));
    }
    
    closePeerConnection(activeTransfer.peerId);
    resetActiveTransfer();
    AudioFeedback.playError();
};

// Conclude Successful Transfer
function concludeTransferSuccess(receivedBlob = null) {
    // Stop timers
    if (connectionTimeout) clearTimeout(connectionTimeout);
    
    hideModal(el.progressModal);
    AudioFeedback.playSuccess();
    
    if (activeTransfer.type === 'receive' && receivedBlob) {
        setupFilePreview(receivedBlob, activeTransfer.fileName, activeTransfer.fileSize, activeTransfer.fileType);
        addHistoryRecord('received', activeTransfer.fileName, activeTransfer.fileSize, activeTransfer.fileType, 'Completed', receivedBlob);
    } else {
        addHistoryRecord('sent', activeTransfer.fileName, activeTransfer.fileSize, activeTransfer.fileType, 'Completed');
        if (sendingQueue && sendingQueue.length > 0) {
            setTimeout(sendNextFileInQueue, 600);
        } else {
            alert('All files sent successfully!');
            closePeerConnection(activeTransfer.peerId);
            resetActiveTransfer();
        }
    }
}

// Setup preview file viewer before saving
function setupFilePreview(blob, name, size, type) {
    el.previewFileTitle.textContent = `${name} (${formatBytes(size)}) received successfully`;
    el.previewMediaContainer.innerHTML = '';
    
    const fileUrl = URL.createObjectURL(blob);
    el.btnDownloadFile.href = fileUrl;
    el.btnDownloadFile.download = name;
    
    // Image Preview
    if (type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = fileUrl;
        img.alt = name;
        el.previewMediaContainer.appendChild(img);
    } 
    // Video Preview
    else if (type.startsWith('video/')) {
        const video = document.createElement('video');
        video.src = fileUrl;
        video.controls = true;
        video.autoplay = true;
        el.previewMediaContainer.appendChild(video);
    } 
    // Audio Preview
    else if (type.startsWith('audio/')) {
        const div = document.createElement('div');
        div.className = 'preview-audio-player';
        div.innerHTML = `
            <div class="audio-artwork"><i class="fa-solid fa-music"></i></div>
            <div class="audio-meta">
                <h4>${name}</h4>
                <p>Audio Track</p>
            </div>
            <div class="audio-controls">
                <audio src="${fileUrl}" controls autoplay></audio>
            </div>
        `;
        el.previewMediaContainer.appendChild(div);
    } 
    // PDF Preview
    else if (type === 'application/pdf') {
        const embed = document.createElement('embed');
        embed.src = `${fileUrl}#toolbar=0&navpanes=0&scrollbar=0`;
        embed.type = 'application/pdf';
        embed.style.width = '100%';
        embed.style.height = '380px';
        el.previewMediaContainer.appendChild(embed);
    } 
    // Generic File Preview
    else {
        const div = document.createElement('div');
        div.className = 'preview-generic-file';
        div.innerHTML = `
            <div class="generic-file-icon">${getFileIconHTML(type)}</div>
            <div class="generic-file-meta">
                <h4>${name}</h4>
                <p>${formatBytes(size)} • Unknown Format</p>
            </div>
        `;
        el.previewMediaContainer.appendChild(div);
    }
    
    // Clean URL on preview modal close
    el.btnPreviewDone.onclick = el.btnClosePreview.onclick = () => {
        hideModal(el.previewModal);
        URL.revokeObjectURL(fileUrl);
        closePeerConnection(activeTransfer.peerId);
        resetActiveTransfer();
    };
    
    showModal(el.previewModal);
}

// Reset state
function resetActiveTransfer() {
    activeTransfer = {
        peerId: null,
        peerName: '',
        type: null,
        mode: null,
        fileName: '',
        fileSize: 0,
        fileType: '',
        chunks: [],
        chunksReceived: 0,
        totalChunks: 0,
        bytesTransferred: 0,
        startTime: 0,
        timer: null,
        isCancelled: false,
        file: null
    };
    currentRecipientPeerId = null;
}

// Progress Metrics computations
function updateProgressStats() {
    const bytes = activeTransfer.bytesTransferred;
    const total = activeTransfer.fileSize;
    const pct = Math.min(100, Math.floor((bytes / total) * 100));
    
    // Calculate speed
    const elapsed = (Date.now() - activeTransfer.startTime) / 1000; // in seconds
    let speed = 0;
    let eta = 'calculating...';
    
    if (elapsed > 0.2) {
        speed = bytes / elapsed; // bytes/sec
        const bytesLeft = total - bytes;
        const etaSeconds = speed > 0 ? Math.ceil(bytesLeft / speed) : 0;
        
        eta = etaSeconds > 0 ? `${etaSeconds}s` : '0s';
    }
    
    updateProgressUI(pct);
    el.progressSpeed.textContent = formatBytes(speed) + '/s';
    el.progressTimeEta.textContent = eta;
}

function updateProgressUI(pct) {
    el.progressPct.textContent = `${pct}%`;
    
    // SVG radial offset (radius = 58, perimeter = 2 * PI * r = ~364.4)
    const strokeLength = 364.4;
    const offset = strokeLength - (pct / 100) * strokeLength;
    el.progressRingBar.style.strokeDashoffset = offset;
}

// Utilities Helpers
function formatBytes(bytes, decimals = 1) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function getFileIconHTML(mimeType) {
    if (mimeType.startsWith('image/')) return '<i class="fa-solid fa-file-image" style="color: #f43f5e"></i>';
    if (mimeType.startsWith('video/')) return '<i class="fa-solid fa-file-video" style="color: #8b5cf6"></i>';
    if (mimeType.startsWith('audio/')) return '<i class="fa-solid fa-file-audio" style="color: #ec4899"></i>';
    if (mimeType === 'application/pdf') return '<i class="fa-solid fa-file-pdf" style="color: #ef4444"></i>';
    if (mimeType.startsWith('text/') || mimeType.includes('document')) return '<i class="fa-solid fa-file-lines" style="color: #3b82f6"></i>';
    return '<i class="fa-solid fa-file" style="color: #a1a1aa"></i>';
}

// Start application
window.onload = initApp;

// Custom Device Name Renamer
function saveCustomDeviceName() {
    const newName = el.inputDeviceName.value.trim();
    if (!newName) return;
    
    myName = newName;
    el.myName.textContent = myName;
    
    // Save to localStorage to persist across refreshes
    localStorage.setItem('dropit_device_name', myName);
    
    // Notify server of rename
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'rename',
            name: myName
        }));
    }
    
    hideModal(el.renameModal);
    AudioFeedback.playSuccess();
}

// Sharing History Engine
function loadSharingHistory() {
    try {
        const saved = localStorage.getItem('dropit_history');
        if (saved) {
            sharingHistory = JSON.parse(saved);
        }
    } catch (e) {
        console.error('Failed to load sharing history:', e);
        sharingHistory = [];
    }
}

function addHistoryRecord(direction, name, size, type, status, receivedBlob = null) {
    const historyId = 'h-' + Math.random().toString(36).substring(2, 11) + '-' + Date.now();
    
    const record = {
        id: historyId,
        direction: direction, // 'sent' or 'received' or 'failed'
        name: name,
        size: size,
        type: type,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        status: status, // 'Completed', 'Cancelled', 'Failed'
        partner: activeTransfer.peerName || 'Unknown Device'
    };
    
    sharingHistory.unshift(record);
    
    // Limit to 50 entries
    if (sharingHistory.length > 50) {
        const removed = sharingHistory.pop();
        receivedBlobsMap.delete(removed.id);
    }
    
    try {
        localStorage.setItem('dropit_history', JSON.stringify(sharingHistory));
    } catch (e) {
        console.error('Failed to save sharing history:', e);
    }
    
    if (receivedBlob) {
        receivedBlobsMap.set(historyId, receivedBlob);
    }
    
    if (el.historyModal.classList.contains('active')) {
        renderHistoryList();
    }
}

function renderHistoryList() {
    const list = el.historyListContainer;
    list.innerHTML = '';
    
    if (sharingHistory.length === 0) {
        list.appendChild(el.historyEmptyState);
        el.historyEmptyState.style.display = 'flex';
        return;
    }
    
    el.historyEmptyState.style.display = 'none';
    
    sharingHistory.forEach(record => {
        const card = document.createElement('div');
        card.className = 'history-card';
        
        let dirClass = 'failed';
        let iconClass = 'fa-xmark';
        if (record.direction === 'sent') {
            dirClass = 'sent';
            iconClass = 'fa-arrow-up-long';
        } else if (record.direction === 'received') {
            dirClass = 'received';
            iconClass = 'fa-arrow-down-long';
        }
        
        card.innerHTML = `
            <div class="history-card-direction ${dirClass}" title="${record.direction}">
                <i class="fa-solid ${iconClass}"></i>
            </div>
            <div class="history-card-meta">
                <div class="history-card-title">${record.name}</div>
                <div class="history-card-sub">${formatBytes(record.size)} • ${record.partner} • ${record.timestamp}</div>
            </div>
            <div class="history-actions" id="history-actions-${record.id}"></div>
        `;
        
        const actionsContainer = card.querySelector(`#history-actions-${record.id}`);
        
        if (record.direction === 'received' && receivedBlobsMap.has(record.id)) {
            const blob = receivedBlobsMap.get(record.id);
            const url = URL.createObjectURL(blob);
            const dlBtn = document.createElement('a');
            dlBtn.className = 'btn btn-secondary btn-icon';
            dlBtn.style.width = '32px';
            dlBtn.style.height = '32px';
            dlBtn.href = url;
            dlBtn.download = record.name;
            dlBtn.title = 'Download File';
            dlBtn.innerHTML = '<i class="fa-solid fa-arrow-down" style="font-size: 0.8rem;"></i>';
            actionsContainer.appendChild(dlBtn);
        } else {
            const badge = document.createElement('span');
            badge.className = 'transfer-mode-badge';
            if (record.status === 'Completed') {
                badge.style.background = 'rgba(16, 185, 129, 0.08)';
                badge.style.borderColor = 'rgba(16, 185, 129, 0.15)';
                badge.style.color = 'var(--success-color)';
            } else {
                badge.style.background = 'rgba(239, 68, 68, 0.08)';
                badge.style.borderColor = 'rgba(239, 68, 68, 0.15)';
                badge.style.color = 'var(--danger-color)';
            }
            badge.textContent = record.status;
            badge.style.fontSize = '0.65rem';
            badge.style.padding = '2px 6px';
            actionsContainer.appendChild(badge);
        }
        
        list.appendChild(card);
    });
}

function clearSharingHistory() {
    if (confirm('Are you sure you want to clear your transfer history?')) {
        sharingHistory = [];
        receivedBlobsMap.clear();
        localStorage.removeItem('dropit_history');
        renderHistoryList();
        AudioFeedback.playSuccess();
    }
}
