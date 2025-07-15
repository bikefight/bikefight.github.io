// client-side script using REST & WebSocket backend
(function () {
  const userIdKey = 'tracker_userId';
  const userNameKey = 'tracker_userName';
  const splashScreen = document.getElementById('splash-screen');

  // Generate or retrieve user id
  let userId = localStorage.getItem(userIdKey);
  if (!userId) {
    if (window.crypto?.randomUUID) {
      userId = crypto.randomUUID();
    } else {
      userId = 'user-' + Math.random().toString(36).slice(2);
    }
    localStorage.setItem(userIdKey, userId);
  }

  // UI elements for name prompt
  let userName = localStorage.getItem(userNameKey);
  const namePromptEl = document.getElementById('namePrompt');
  const nameInputEl = document.getElementById('nameInput');
  const saveNameBtn = document.getElementById('saveNameBtn');

  function toggleNamePrompt(show) {
    namePromptEl.classList.toggle('hidden', !show);
  }

  if (!userName) toggleNamePrompt(true);

  saveNameBtn.addEventListener('click', () => {
    const value = nameInputEl.value.trim();
    if (value) {
      userName = value;
      localStorage.setItem(userNameKey, userName);
      toggleNamePrompt(false);
      if (currentPosition) {
        updateMarker(userId, currentPosition.lat, currentPosition.lng, userName);
      }
    }
  });

  // Leaflet map setup
  const map = L.map('map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  // Crosshair icons
  const crossSelf = L.divIcon({
    className: 'crosshair-icon self',
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });
  const crossFriend = L.divIcon({
    className: 'crosshair-icon friend',
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });
  
  // Add location button
  const locationButton = L.control({ position: 'bottomright' });
  locationButton.onAdd = function() {
    const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    div.innerHTML = '<a href="#" title="My Location" style="display: block; width: 30px; height: 30px; text-align: center; line-height: 30px; font-size: 18px;">📍</a>';
    div.onclick = function(e) {
      e.preventDefault();
      if (currentPosition) {
        map.setView([currentPosition.lat, currentPosition.lng], 15);
      }
    };
    return div;
  };
  locationButton.addTo(map);

  // ========== Camera & Challenge Logic ==========
  const cameraModal = document.getElementById('cameraModal');
  const cameraVideo = document.getElementById('cameraVideo');
  const captureBtn = document.getElementById('captureBtn');
  const cancelCameraBtn = document.getElementById('cancelCameraBtn');
  const challengeModal = document.getElementById('challengeModal');
  const challengeImgEl = document.getElementById('challengeImg');
  const acceptBtn = document.getElementById('acceptBtn');
  const declineBtn = document.getElementById('declineBtn');
  const ratingGroups = document.querySelectorAll('.rating-group');
  const ratings = { beauty: 3, creativity: 3, creepiness: 3 };

  // initialize star rating handlers
  ratingGroups.forEach(group => {
    const field = group.dataset.field;
    const stars = group.querySelectorAll('.star');
    // highlight default 3
    stars.forEach(star => {
      if (Number(star.dataset.val) <= 3) star.classList.add('selected');
      star.addEventListener('click', () => {
        const val = Number(star.dataset.val);
        ratings[field] = val;
        stars.forEach(s => s.classList.toggle('selected', Number(s.dataset.val) <= val));
      });
    });
  });

  let mediaStream = null;
  let challengeTargetId = null;

  function openCamera(id) {
    challengeTargetId = id;
    navigator.mediaDevices.getUserMedia({ video: true }).then(stream => {
      mediaStream = stream;
      cameraVideo.srcObject = stream;
      cameraVideo.play();
      cameraModal.classList.remove('hidden');
    }).catch(err => alert('Cannot access camera: ' + err));
  }

  function closeCamera() {
    cameraModal.classList.add('hidden');
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
  }

  captureBtn.addEventListener('click', () => {
    const canvas = document.createElement('canvas');
    canvas.width = cameraVideo.videoWidth;
    canvas.height = cameraVideo.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(cameraVideo, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    // send challenge to server
    fetch('/api/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_id: userId, to_id: challengeTargetId, image: dataUrl })
    }).then(() => {
      alert('Challenge sent!');
      closeCamera();
    }).catch(err => alert('Failed to send challenge: ' + err));
  });
  cancelCameraBtn.addEventListener('click', closeCamera);

  // Handle incoming WS messages (extend existing listener)
  // listener will be added after ws is created below

  acceptBtn.addEventListener('click', () => submitChallengeResponse(true));
  declineBtn.addEventListener('click', () => submitChallengeResponse(false));

  function submitChallengeResponse(accepted) {
    const id = challengeModal.dataset.challengeId;
    // ratings object already populated via star clicks
    fetch('/api/response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, accepted, ...ratings })
    }).then(() => {
      challengeModal.classList.add('hidden');
    });
  }

  // Add click listener on markers for challenge
  function attachMarkerClick(marker, id) {
    marker.on('click', () => {
      if (id === userId) return;
      openCamera(id);
    });
  }

  const markers = {};
  let currentPosition = null;

  function updateMarker(id, lat, lng, name) {
    let marker = markers[id];
    const icon = id === userId ? crossSelf : crossFriend;
    if (!marker) {
      marker = L.marker([lat, lng], { icon }).addTo(map);
      markers[id] = marker;
      if (id === userId) {
        marker.bindTooltip(name, {
          permanent: true,
          direction: 'top',
          offset: [0, -18],
          className: 'marker-label'
        });
      }
      attachMarkerClick(marker, id);
    } else {
      marker.setLatLng([lat, lng]);
      marker.setIcon(icon);
      if (id === userId && marker.getTooltip()) {
        marker.setTooltipContent(name);
      }
    }
    if (id !== userId && name) {
      marker.bindPopup(name);
    }
  }

  const xpEl = document.getElementById('xpDisplay');
  let userPoints = 0;
  function updateXP() {
    xpEl.textContent = userPoints + 'xp';
  }

  function formatTimeAgo(timestamp) {
    const now = Date.now();
    const diff = now - new Date(timestamp).getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (seconds < 60) return `(${seconds}s)`;
    if (minutes < 60) return `(${minutes}m)`;
    if (hours < 24) return `(${hours}h)`;
    return `(${Math.floor(hours / 24)}d)`;
  }

  function updateMarkerLabel(id, name, timestamp) {
    const timeStr = timestamp ? formatTimeAgo(timestamp) : '';
    const label = name + ' ' + timeStr;
    const marker = markers[id];
    if (marker) {
      if (id === userId && marker.getTooltip()) {
        marker.setTooltipContent(label);
      } else if (id !== userId) {
        marker.bindPopup(label);
      }
    }
  }

  // REST: get existing users on load
  fetch('/api/users')
    .then(r => r.json())
    .then(list => {
      // find self to set points
      const me = list.find(u => u.id === userId);
      if (me && typeof me.points === 'number') {
        userPoints = me.points;
        updateXP();
      }
      list.forEach(u => {
        updateMarker(u.id, u.lat, u.lng, u.name || 'Friend');
        updateMarkerLabel(u.id, u.name || 'Friend', u.updated);
      });
      // Hide splash screen after first data load
      splashScreen.classList.add('hidden');
    })
    .catch(err => {
      console.error('Failed to fetch users', err);
      // Also hide splash screen on error to not block the page
      splashScreen.classList.add('hidden');
    });

  // WebSocket for real-time updates
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(wsProtocol + '//' + location.host + '/?uid=' + encodeURIComponent(userId));

  ws.addEventListener('message', evt => {
    const data = JSON.parse(evt.data);
    if (data.type === 'init') {
      data.users.forEach(u => updateMarker(u.id, u.lat, u.lng, u.name));
      data.users.forEach(u => updateMarkerLabel(u.id, u.name || 'Friend', u.updated));
      const me = data.users.find(u => u.id === userId);
      if (me && typeof me.points === 'number') {
        userPoints = me.points;
        updateXP();
      }
      return;
    }
    if (data.type === 'challenge') {
      // incoming challenge (recipient side)
      challengeImgEl.src = data.image;
      challengeModal.dataset.challengeId = data.id;
      challengeModal.classList.remove('hidden');
      return;
    }
    if (data.type === 'challenge_result') {
      if (data.points && data.from_id === userId) {
        userPoints += data.points;
        updateXP();
        alert('You earned ' + data.points + ' points!');
      }
      return;
    }
    const { id, name, lat, lng, updated } = data;
    if (id !== userId) {
      updateMarker(id, lat, lng, name || 'Friend');
      updateMarkerLabel(id, name || 'Friend', updated);
    }
  });

  // Send our location to server via REST
  function sendLocation(lat, lng) {
    fetch('/api/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: userId, name: userName || 'Anonymous', lat, lng })
    }).catch(err => console.error('Failed to send location', err));
  }

  // Geolocation tracking
  if ('geolocation' in navigator) {
    // Get initial position to center map
    navigator.geolocation.getCurrentPosition(pos => {
      const { latitude, longitude } = pos.coords;
      map.setView([latitude, longitude], 15);
    }, err => {
      console.error('Initial geolocation error', err);
      map.setView([0, 0], 2); // fallback to world view
    });

    navigator.geolocation.watchPosition(pos => {
      const { latitude, longitude } = pos.coords;
      currentPosition = { lat: latitude, lng: longitude };
      updateMarker(userId, latitude, longitude, userName || 'Me');
      updateMarkerLabel(userId, userName || 'Me', new Date().toISOString());
      sendLocation(latitude, longitude);
    }, err => {
      console.error('Geolocation error', err);
      alert('Unable to retrieve location: ' + err.message);
    }, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 10000
    });
  } else {
    alert('Geolocation not supported.');
    map.setView([0, 0], 2); // fallback to world view
  }
})(); 