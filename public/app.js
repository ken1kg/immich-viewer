/*
    Immich Viewer - Legacy Browser Compatible (ES5)
    Works on iOS 9+ Safari
*/

(function () {
    // --- Configuration ---
    // Read config injected by server or fall back to defaults
    var serverConfig = window.IMMICH_CONFIG || {};

    var CONFIG = {
        interval: (serverConfig.interval) || 15,
        transition: (serverConfig.transition) || 'fade',
        albumId: (serverConfig.albumId) || '',
        imageFit: (serverConfig.imageFit) || 'cover',
        imageQuality: (serverConfig.imageQuality) || 'preview',
        debug: (serverConfig.debug) === true
    };

    // Global State
    var state = {
        assets: [],
        currentIndex: 0,
        nextIndex: 1,
        isLoading: true,
        slideA: null,
        slideB: null,
        activeSlide: 'a', // 'a' or 'b'
        timer: null,
        loadToken: 0,  // Identifies the latest image load request
        failedInRow: 0 // Consecutive images that failed to load
    };

    // DOM Elements
    var el = {
        statusOverlay: document.getElementById('status-overlay'),
        statusText: document.getElementById('status-text'),
        retryBtn: document.getElementById('retry-btn'),
        slideA: document.getElementById('slide-a'),
        slideB: document.getElementById('slide-b'),
        bgA: document.getElementById('bg-a'),
        bgB: document.getElementById('bg-b'),
        time: document.getElementById('time'),
        date: document.getElementById('date'),
        clockOverlay: document.getElementById('clock-overlay'),
        slideshow: document.getElementById('slideshow')
    };

    // Apply Image Fit Class
    el.slideshow.className = 'slideshow fit-' + CONFIG.imageFit;

    // --- Utilities ---

    function log(msg) {
        if (CONFIG.debug) {
            console.log('[ImmichViewer] ' + msg);
        }
    }

    function showError(msg, showRetry) {
        el.statusText.textContent = msg;
        el.statusOverlay.classList.remove('hidden');
        if (showRetry) {
            el.retryBtn.classList.remove('hidden');
        }
    }

    function hideLoading() {
        el.statusOverlay.classList.add('hidden');
    }

    function shuffleArray(array) {
        for (var i = array.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var temp = array[i];
            array[i] = array[j];
            array[j] = temp;
        }
        return array;
    }

    // --- API Interaction (XMLHttpRequest for legacy support) ---

    var PAGE_SIZE = 1000;          // Immich max page size for /search/metadata
    var MAX_PAGES = 20;            // Per album / favorites. Bounds memory on 1GB devices
    var REFRESH_MS = 60 * 60 * 1000; // Check for newly added photos every hour

    // silent: background refresh - never shows errors or triggers the network watchdog
    function fetchAssets(silent, onSuccess, onFail) {
        var albumIds = CONFIG.albumId ? CONFIG.albumId.split(',') : [];
        // Clean up whitespace
        albumIds = albumIds.map(function (id) { return id.trim(); }).filter(function (id) { return id.length > 0; });

        // Each source is one album, or Favorites when no albums are configured
        var sources = [];
        for (var i = 0; i < albumIds.length; i++) {
            sources.push({ albumIds: [albumIds[i]] });
        }
        if (sources.length === 0) sources.push({ isFavorite: true });

        // Keep only asset ids - full asset objects for thousands of photos waste memory
        var allAssets = [];
        var seen = {};
        var completedSources = 0;

        function sourceDone() {
            completedSources++;
            if (completedSources >= sources.length) {
                if (allAssets.length === 0) {
                    onFail();
                } else {
                    onSuccess(allAssets);
                }
            }
        }

        function fetchPage(source, page) {
            var body = { size: PAGE_SIZE };
            if (source.albumIds) body.albumIds = source.albumIds;
            if (source.isFavorite) body.isFavorite = true;
            if (page > 1) body.page = page;

            var url = '/api/proxy/search/metadata';
            var xhr = new XMLHttpRequest();
            xhr.open('POST', url, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    var data;
                    try {
                        data = JSON.parse(xhr.responseText);
                    } catch (e) {
                        console.error(e);
                        if (!silent) {
                            showError('JSON Parse Error: ' + e.message, true);
                            handleNetworkError();
                        }
                        sourceDone();
                        return;
                    }

                    var assets = [];
                    if (data.assets && Array.isArray(data.assets.items)) {
                        assets = data.assets.items;
                    } else if (data.assets && Array.isArray(data.assets)) {
                        assets = data.assets;
                    } else if (Array.isArray(data)) {
                        assets = data;
                    }

                    for (var j = 0; j < assets.length; j++) {
                        var asset = assets[j];
                        if (asset && asset.type === 'IMAGE' && asset.id && !seen[asset.id]) {
                            seen[asset.id] = true;
                            allAssets.push({ id: asset.id });
                        }
                    }

                    var nextPage = data.assets && data.assets.nextPage;
                    if (nextPage && page < MAX_PAGES) {
                        log('Fetching page ' + (page + 1));
                        fetchPage(source, parseInt(nextPage, 10) || page + 1);
                    } else {
                        sourceDone();
                    }
                } else {
                    console.error('Server Error ' + xhr.status + ' for ' + url);
                    // Don't show error immediately on partial failure, unless all fail
                    if (!silent) handleNetworkError();
                    sourceDone();
                }
            };
            xhr.onerror = function () {
                console.error('Network error for ' + url);
                if (!silent) handleNetworkError();
                sourceDone();
            };
            xhr.send(JSON.stringify(body));
        }

        for (var k = 0; k < sources.length; k++) {
            log(sources[k].albumIds ? 'Fetching album: ' + sources[k].albumIds[0] : 'Fetching favorites (default)');
            fetchPage(sources[k], 1);
        }
    }

    function getOriginalUrl(assetId) {
        // Full quality original. Requires 'asset.download' permission
        return '/api/proxy/assets/' + assetId + '/original';
    }

    function getAssetUrl(assetId) {
        if (CONFIG.imageQuality === 'original') {
            return getOriginalUrl(assetId);
        }
        // Resized JPEG (~1440px) generated by Immich. Much lighter on memory than
        // originals and always decodable by old Safari (originals may be HEIC)
        return '/api/proxy/assets/' + assetId + '/thumbnail?size=preview';
    }

    // --- Slideshow Logic ---

    var MAX_SKIP_CHAIN = 5; // Unloadable images skipped back-to-back before waiting for the next tick

    function startSlideshow(assets) {
        state.assets = shuffleArray(assets);
        log('Loaded ' + state.assets.length + ' images');

        hideLoading();

        // Show Clock
        el.clockOverlay.classList.remove('hidden');
        updateClock();
        setInterval(updateClock, 1000 * 60);

        // Initial Slide
        showSlide(0, 1);

        // Start Timer
        restartTimer();

        // Pick up photos added to Immich without needing a reload
        setInterval(refreshAssets, REFRESH_MS);
    }

    function restartTimer() {
        if (state.timer) clearInterval(state.timer);
        state.timer = setInterval(function () {
            nextSlide();
        }, CONFIG.interval * 1000);
    }

    // Insert newly added photos right after the current slide so they show up soon.
    // Deleted photos are left in the list; they fail to load and get skipped.
    function refreshAssets() {
        fetchAssets(true, function (assets) {
            var known = {};
            for (var i = 0; i < state.assets.length; i++) {
                known[state.assets[i].id] = true;
            }
            var added = assets.filter(function (asset) { return !known[asset.id]; });
            if (added.length === 0) return;

            // +2 keeps the index of an in-flight next slide unchanged
            var insertAt = Math.min(state.currentIndex + 2, state.assets.length);
            state.assets = state.assets.slice(0, insertAt)
                .concat(shuffleArray(added))
                .concat(state.assets.slice(insertAt));
            log('Refresh: added ' + added.length + ' new images');
        }, function () {
            log('Refresh: failed or empty, keeping current list');
        });
    }

    function showSlide(index, direction) {
        var asset = state.assets[index];
        if (!asset) return;

        // Newer requests (e.g. fast swipes) supersede older in-flight loads
        state.loadToken++;
        loadSlideImage(index, direction, getAssetUrl(asset.id), state.loadToken, false);
    }

    function loadSlideImage(index, direction, imgUrl, token, isFallback) {
        // Preload image
        var img = new Image();
        img.onload = function () {
            if (token !== state.loadToken) return;

            // Apply to inactive slide
            var nextSlideEl = state.activeSlide === 'a' ? el.slideB : el.slideA;
            var currentSlideEl = state.activeSlide === 'a' ? el.slideA : el.slideB;
            var nextBgEl = state.activeSlide === 'a' ? el.bgB : el.bgA;
            var currentBgEl = state.activeSlide === 'a' ? el.bgA : el.bgB;

            // Set both foreground and background
            nextSlideEl.src = imgUrl;
            nextBgEl.src = imgUrl;

            // Trigger transition
            // Swap classes for both layers
            nextSlideEl.classList.add('active');
            currentSlideEl.classList.remove('active');
            nextBgEl.classList.add('active');
            currentBgEl.classList.remove('active');

            // Update state
            state.activeSlide = state.activeSlide === 'a' ? 'b' : 'a';
            state.currentIndex = index;
            state.failedInRow = 0;

            // Watchdog tick - only on a photo actually shown
            updateLastSlideTime();
        };
        img.onerror = function () {
            if (token !== state.loadToken) return;
            var asset = state.assets[index];
            if (!asset) return;

            // Preview missing or undecodable (e.g. preview format set to WebP) - try the original
            if (!isFallback && imgUrl !== getOriginalUrl(asset.id)) {
                log('Preview failed, trying original: ' + asset.id);
                loadSlideImage(index, direction, getOriginalUrl(asset.id), token, true);
                return;
            }

            // Skip it: move past this asset so the next tick doesn't retry it
            log('Skipping unloadable image: ' + asset.id);
            state.currentIndex = index;
            state.failedInRow++;
            if (state.failedInRow < MAX_SKIP_CHAIN && state.assets.length > 1) {
                var count = state.assets.length;
                showSlide((index + direction + count) % count, direction);
            }
            // Otherwise wait for the next timer tick; if nothing loads the watchdog reloads
        };
        img.src = imgUrl; // Start loading
    }

    function nextSlide() {
        if (state.assets.length === 0) return;
        var next = (state.currentIndex + 1) % state.assets.length;
        showSlide(next, 1);
    }

    function prevSlide() {
        if (state.assets.length === 0) return;
        var prev = (state.currentIndex - 1 + state.assets.length) % state.assets.length;
        showSlide(prev, -1);
    }

    // --- Clock ---

    // --- Clock & Burn-in Protection ---

    function updateClock() {
        var now = new Date();
        var hours = now.getHours();
        var minutes = now.getMinutes();
        var ampm = hours >= 12 ? 'PM' : 'AM';

        // 12hr format
        hours = hours % 12;
        hours = hours ? hours : 12;
        minutes = minutes < 10 ? '0' + minutes : minutes;

        el.time.textContent = hours + ':' + minutes;

        // Date: "Mon, Jan 1"
        var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        el.date.textContent = days[now.getDay()] + ', ' + months[now.getMonth()] + ' ' + now.getDate();

        // Burn-in Protection: Move clock every minute
        moveClock();
    }

    function moveClock() {
        // 4 Corners + Random slight offset to prevent static pixels even in corners
        // Offsets between 20px and 50px
        function getOffset() { return Math.floor(Math.random() * 30) + 20 + 'px'; }

        var positions = [
            { bottom: getOffset(), right: getOffset(), top: 'auto', left: 'auto', textAlign: 'right' }, // BR
            { bottom: getOffset(), left: getOffset(), top: 'auto', right: 'auto', textAlign: 'left' },  // BL
            { top: getOffset(), left: getOffset(), bottom: 'auto', right: 'auto', textAlign: 'left' },  // TL
            { top: getOffset(), right: getOffset(), bottom: 'auto', left: 'auto', textAlign: 'right' }  // TR
        ];

        // Randomly pick a corner
        var pos = positions[Math.floor(Math.random() * positions.length)];

        el.clockOverlay.style.bottom = pos.bottom;
        el.clockOverlay.style.right = pos.right;
        el.clockOverlay.style.top = pos.top;
        el.clockOverlay.style.left = pos.left;
        el.clockOverlay.style.textAlign = pos.textAlign;

        // Move music controls to follow the clock
        if (typeof musicPlayer !== 'undefined' && musicPlayer.moveMusicControls) {
            musicPlayer.moveMusicControls();
        }
    }

    // --- Reliability (NoSleep & Watchdog) ---

    // 1. Watchdog: Reload if slideshow stalls
    var lastSlideChange = Date.now();

    // Check every minute
    setInterval(function () {
        var now = Date.now();
        // If no slide change for 3 intervals + 5s buffer, force reload
        var threshold = (CONFIG.interval * 1000 * 3) + 5000;

        if (now - lastSlideChange > threshold) {
            log('Watchdog: Slideshow stalled. Reloading...');
            location.reload();
        }
    }, 60000);

    // 2. Network Watchdog: Track consecutive failures
    var consecutiveFailures = 0;

    function handleNetworkError() {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
            log('Watchdog: Too many network errors. Reloading...');
            location.reload();
        }
    }

    // 3. NoSleep Video Logic
    var noSleepActive = false;
    var noSleepTimeout = null;

    function enableNoSleep() {
        var video = document.getElementById('nosleep-video');
        var btn = document.getElementById('nosleep-btn');

        // Toggle off if already active
        if (noSleepActive) {
            // Clear any pending timeout
            if (noSleepTimeout) {
                clearTimeout(noSleepTimeout);
                noSleepTimeout = null;
            }

            if (video) {
                video.pause();
            }
            if (btn) {
                btn.textContent = 'Prevent Sleep';
                btn.classList.remove('btn-success');
            }
            noSleepActive = false;
            log('NoSleep: Disabled');
            return;
        }

        // Immediate feedback to prove click works
        if (btn) btn.textContent = 'Activating...';

        if (!video) {
            console.error('NoSleep Error: Video element not found');
            if (btn) btn.textContent = 'Err: No Video';
            return;
        }

        try {
            var playPromise = video.play();
            var promiseResolved = false;

            // Logic for modern browsers (Promise)
            if (playPromise !== undefined) {
                playPromise.then(function () {
                    promiseResolved = true;
                    log('NoSleep: Video playing (Promise resolved).');
                    if (noSleepActive || !promiseResolved) {
                        updateBtnSuccess('NoSleep: ON');
                    }
                }).catch(function (e) {
                    promiseResolved = true;
                    console.error('NoSleep failed (Promise rejected):', e);
                    // Only show error if we're still trying to activate (not toggled off)
                    if (noSleepActive && btn) {
                        btn.textContent = 'Err: ' + e.name;
                    }
                });

                // Timeout fallback for hanging promises (common on legacy iOS)
                noSleepTimeout = setTimeout(function () {
                    if (!promiseResolved) {
                        log('NoSleep: Promise timeout. Forcing success state.');
                        updateBtnSuccess('NoSleep: ON (Forced)');
                    }
                    noSleepTimeout = null;
                }, 500);
            } else {
                // Logic for legacy browsers (Synchronous/Void)
                log('NoSleep: Video played (Legacy void return).');
                updateBtnSuccess('NoSleep: ON');
            }
        } catch (err) {
            console.error('NoSleep Error:', err);
            if (btn) btn.textContent = 'Err: ' + err.message;
        }

        function updateBtnSuccess(text) {
            if (btn) {
                btn.textContent = text || 'NoSleep: ON';
                btn.classList.add('btn-success');
            }
            noSleepActive = true;
        }
    }

    // --- Initialization ---

    function init() {
        log('Initializing Immich Legacy Viewer');

        // Check for standalone mode (fullscreen)
        if (window.navigator.standalone === true) {
            document.getElementById('fs-instructions').style.display = 'none';
        } else {
            document.getElementById('dismiss-fs').addEventListener('click', function () {
                document.getElementById('fs-instructions').style.display = 'none';
            });
        }

        // Add Legacy Fullscreen Button support
        var fsBtn = document.getElementById('fs-btn');
        fsBtn.addEventListener('click', function () {
            var docEl = document.documentElement;
            if (docEl.requestFullscreen) { docEl.requestFullscreen(); }
            else if (docEl.mozRequestFullScreen) { docEl.mozRequestFullScreen(); }
            else if (docEl.webkitRequestFullscreen) { docEl.webkitRequestFullscreen(); }
            else if (docEl.msRequestFullscreen) { docEl.msRequestFullscreen(); }
        });

        // NoSleep Button
        var nsBtn = document.getElementById('nosleep-btn');
        if (nsBtn) {
            nsBtn.addEventListener('click', enableNoSleep);
        }

        // Toggle controls on tap
        el.slideshow.addEventListener('click', function () {
            var controls = document.getElementById('controls');
            if (controls.classList.contains('hidden')) {
                controls.classList.remove('hidden');
                setTimeout(function () { controls.classList.add('hidden'); }, 5000);
            } else {
                controls.classList.add('hidden');
            }
        });

        // Refresh Button
        document.getElementById('refresh-btn').addEventListener('click', function () {
            location.reload();
        });

        // Keyboard Navigation
        document.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowRight' || e.key === 'Right') {
                manualNext();
            } else if (e.key === 'ArrowLeft' || e.key === 'Left') {
                manualPrev();
            }
        });

        // Touch Swipe Navigation
        var touchStartX = 0;
        var touchEndX = 0;

        el.slideshow.addEventListener('touchstart', function (e) {
            touchStartX = e.changedTouches[0].screenX;
        }, false);

        el.slideshow.addEventListener('touchend', function (e) {
            touchEndX = e.changedTouches[0].screenX;
            handleSwipe();
        }, false);

        function handleSwipe() {
            var swipeThreshold = 50; // minimum distance for swipe
            var diff = touchStartX - touchEndX;

            if (Math.abs(diff) > swipeThreshold) {
                if (diff > 0) {
                    // Swiped left, show next
                    manualNext();
                } else {
                    // Swiped right, show previous
                    manualPrev();
                }
            }
        }

        fetchAssets(false, function (assets) {
            startSlideshow(assets);
        }, function () {
            showError('No images found in any provided albums.', true);
            handleNetworkError();
        });

        // Initialize music player (async check for availability)
        musicPlayer.init();
    }

    // Manual navigation restarts the auto-advance timer so it doesn't fire right after a swipe
    function manualNext() {
        if (state.assets.length === 0) return;
        nextSlide();
        restartTimer();
    }

    function manualPrev() {
        if (state.assets.length === 0) return;
        prevSlide();
        restartTimer();
    }

    function updateLastSlideTime() {
        lastSlideChange = Date.now();
        consecutiveFailures = 0; // Reset network errors on success
    }

    // --- Music Player ---
    var musicPlayer = {
        el: {
            btn: document.getElementById('music-btn'),
            overlay: document.getElementById('music-overlay'),
            closeBtn: document.getElementById('close-music'),
            shuffleAllBtn: document.getElementById('shuffle-all-btn'),
            shuffleFolderBtn: document.getElementById('shuffle-folder-btn'),
            breadcrumb: document.getElementById('music-breadcrumb'),
            list: document.getElementById('music-list'),
            nowPlaying: document.getElementById('now-playing'),
            audio: document.getElementById('audio-player'),
            // Floating controls
            mcOverlay: document.getElementById('music-controls'),
            mcPlayPause: document.getElementById('mc-play-pause'),
            mcNext: document.getElementById('mc-next'),
            mcPrev: document.getElementById('mc-prev'),
            mcRepeat: document.getElementById('mc-repeat'),
            mcShuffle: document.getElementById('mc-shuffle')
        },
        currentPath: '',
        browsingFiles: [],     // Current folder being viewed
        originalPlaylist: [],   // Sequential tracks (source)
        playingPlaylist: [],   // Actual tracks being navigated (can be shuffled)
        playingIndex: -1,
        repeatMode: 'OFF',     // OFF, ONE, LOOP
        shuffleActive: false,

        init: function () {
            var self = this;
            var xhr = new XMLHttpRequest();
            xhr.open('GET', '/api/music/list', true);
            xhr.onload = function () {
                if (xhr.status === 200) {
                    self.el.btn.classList.remove('hidden');
                    self.bindEvents();
                    self.loadDirectory('');
                }
            };
            xhr.onerror = function () {
                log('Music player not available');
            };
            xhr.send();
        },

        bindEvents: function () {
            var self = this;

            this.el.btn.addEventListener('click', function () { self.show(); });
            this.el.closeBtn.addEventListener('click', function () { self.hide(); });

            this.el.shuffleAllBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                self.shuffleAll();
            });

            this.el.shuffleFolderBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                self.shuffleCurrentFolder();
            });

            this.el.audio.addEventListener('play', function () {
                var src = self.el.audio.currentSrc;
                var filename = decodeURIComponent(src.split('/').pop());
                self.el.nowPlaying.textContent = 'Playing: ' + filename;
                self.el.mcPlayPause.textContent = '⏸';
                self.el.mcOverlay.classList.remove('hidden');
                self.moveMusicControls();
            });

            this.el.audio.addEventListener('pause', function () {
                self.el.mcPlayPause.textContent = '▶️';
            });

            this.el.audio.addEventListener('ended', function () {
                self.handleTrackEnded();
            });

            this.el.mcPlayPause.addEventListener('click', function (e) {
                e.stopPropagation();
                if (self.el.audio.paused) self.el.audio.play();
                else self.el.audio.pause();
            });

            this.el.mcNext.addEventListener('click', function (e) { e.stopPropagation(); self.nextTrack(); });
            this.el.mcPrev.addEventListener('click', function (e) { e.stopPropagation(); self.prevTrack(); });
            this.el.mcRepeat.addEventListener('click', function (e) { e.stopPropagation(); self.cycleRepeatMode(); });
            this.el.mcShuffle.addEventListener('click', function (e) { e.stopPropagation(); self.toggleShuffle(); });
        },

        show: function () { this.el.overlay.classList.remove('hidden'); },
        hide: function () { this.el.overlay.classList.add('hidden'); },

        loadDirectory: function (path) {
            var self = this;
            this.currentPath = path;
            this.updateBreadcrumb(path);

            var xhr = new XMLHttpRequest();
            var url = '/api/music/list?path=' + encodeURIComponent(path);
            xhr.open('GET', url, true);
            xhr.onload = function () {
                if (xhr.status === 200) {
                    try {
                        var data = JSON.parse(xhr.responseText);
                        self.browsingFiles = data.files || [];
                        self.renderList(data);
                    } catch (e) {
                        self.el.list.innerHTML = '<div class="err">Error parsing list</div>';
                    }
                } else {
                    self.el.list.innerHTML = '<div class="err">Failed to load directory</div>';
                }
            };
            xhr.send();
        },

        shuffleCurrentFolder: function () {
            var self = this;
            this.el.nowPlaying.textContent = 'Searching folder...';

            var xhr = new XMLHttpRequest();
            var url = '/api/music/list?recursive=true&path=' + encodeURIComponent(this.currentPath);
            xhr.open('GET', url, true);
            xhr.onload = function () {
                if (xhr.status === 200) {
                    try {
                        var data = JSON.parse(xhr.responseText);
                        if (data.files && data.files.length > 0) {
                            self.originalPlaylist = JSON.parse(JSON.stringify(data.files));
                            self.playingPlaylist = shuffleArray(JSON.parse(JSON.stringify(data.files)));
                            self.shuffleActive = true;
                            self.updateShuffleUI();
                            self.playIndex(0);
                            self.hide();
                        } else {
                            alert('No music files found in this folder or subfolders.');
                        }
                    } catch (e) {
                        alert('Error shuffling folder.');
                    }
                }
            };
            xhr.send();
        },

        shuffleAll: function () {
            var self = this;
            this.el.nowPlaying.textContent = 'Searching library...';

            var xhr = new XMLHttpRequest();
            xhr.open('GET', '/api/music/list?recursive=true', true);
            xhr.onload = function () {
                if (xhr.status === 200) {
                    try {
                        var data = JSON.parse(xhr.responseText);
                        if (data.files && data.files.length > 0) {
                            self.originalPlaylist = JSON.parse(JSON.stringify(data.files));
                            self.playingPlaylist = shuffleArray(JSON.parse(JSON.stringify(data.files)));
                            self.shuffleActive = true;
                            self.updateShuffleUI();
                            self.playIndex(0);
                            self.hide();
                        } else {
                            alert('No music files found in library.');
                        }
                    } catch (e) {
                        alert('Error shuffing library.');
                    }
                }
            };
            xhr.send();
        },

        toggleShuffle: function () {
            if (this.playingPlaylist.length === 0) return;
            var currentTrack = this.playingPlaylist[this.playingIndex];
            this.shuffleActive = !this.shuffleActive;

            if (this.shuffleActive) {
                // Shuffle: Randomize the rest based on original order
                var remaining = [];
                for (var i = 0; i < this.originalPlaylist.length; i++) {
                    if (this.originalPlaylist[i].path !== currentTrack.path) {
                        remaining.push(this.originalPlaylist[i]);
                    }
                }
                this.playingPlaylist = [currentTrack].concat(shuffleArray(remaining));
                this.playingIndex = 0;
            } else {
                // Unshuffle: Restore original order
                this.playingPlaylist = JSON.parse(JSON.stringify(this.originalPlaylist));
                for (var j = 0; j < this.playingPlaylist.length; j++) {
                    if (this.playingPlaylist[j].path === currentTrack.path) {
                        this.playingIndex = j;
                        break;
                    }
                }
            }
            this.updateShuffleUI();
        },

        updateShuffleUI: function () {
            if (this.shuffleActive) this.el.mcShuffle.classList.add('active');
            else this.el.mcShuffle.classList.remove('active');
        },

        updateBreadcrumb: function (path) {
            this.el.breadcrumb.textContent = '/' + (path || '');
        },

        renderList: function (data) {
            var self = this;
            var html = '';

            if (this.currentPath) {
                var parts = this.currentPath.split('/');
                parts.pop();
                var parentPath = parts.join('/');
                html += '<div class="music-item folder" data-type="back" data-path="' + parentPath + '">';
                html += '<span class="music-icon">⬅️</span><span>..</span></div>';
            }

            for (var i = 0; i < data.folders.length; i++) {
                var folder = data.folders[i];
                html += '<div class="music-item folder" data-type="folder" data-path="' + folder.path + '">';
                html += '<span class="music-icon">📁</span><span>' + folder.name + '</span></div>';
            }

            for (var j = 0; j < data.files.length; j++) {
                var file = data.files[j];
                html += '<div class="music-item file" data-type="file" data-path="' + file.path + '">';
                html += '<span class="music-icon">🎵</span><span>' + file.name + '</span></div>';
            }

            this.el.list.innerHTML = html || '<div style="padding:15px;color:#aaa;">Folder is empty</div>';

            var items = this.el.list.querySelectorAll('.music-item');
            for (var k = 0; k < items.length; k++) {
                (function (item) {
                    item.addEventListener('click', function () {
                        var type = item.getAttribute('data-type');
                        var path = item.getAttribute('data-path');
                        if (type === 'file') self.startPlaybackFromList(path);
                        else self.loadDirectory(path);
                    });
                })(items[k]);
            }
        },

        startPlaybackFromList: function (path) {
            this.originalPlaylist = JSON.parse(JSON.stringify(this.browsingFiles));
            this.shuffleActive = false; // Reset shuffle when picking a specific song
            this.playingPlaylist = JSON.parse(JSON.stringify(this.originalPlaylist));
            this.updateShuffleUI();

            for (var i = 0; i < this.playingPlaylist.length; i++) {
                if (this.playingPlaylist[i].path === path) {
                    this.playIndex(i);
                    break;
                }
            }
        },

        playIndex: function (index) {
            if (index < 0 || index >= this.playingPlaylist.length) return;
            this.playingIndex = index;
            var track = this.playingPlaylist[index];
            this.el.audio.src = '/api/music/stream/' + encodeURIComponent(track.path);
            this.el.audio.play();
        },

        nextTrack: function () {
            if (this.playingPlaylist.length === 0) return;
            var next = this.playingIndex + 1;
            if (next >= this.playingPlaylist.length) {
                if (this.repeatMode === 'LOOP') next = 0;
                else return;
            }
            this.playIndex(next);
        },

        prevTrack: function () {
            if (this.playingPlaylist.length === 0) return;
            var prev = this.playingIndex - 1;
            if (prev < 0) {
                if (this.repeatMode === 'LOOP') prev = this.playingPlaylist.length - 1;
                else prev = 0;
            }
            this.playIndex(prev);
        },

        cycleRepeatMode: function () {
            var modes = ['OFF', 'ONE', 'LOOP'];
            var currentIdx = modes.indexOf(this.repeatMode);
            this.repeatMode = modes[(currentIdx + 1) % modes.length];
            var icons = { 'OFF': '🔁 Off', 'ONE': '🔂 One', 'LOOP': '🔁 Loop' };
            this.el.mcRepeat.textContent = icons[this.repeatMode];
        },

        handleTrackEnded: function () {
            if (this.repeatMode === 'ONE') {
                this.el.audio.currentTime = 0;
                this.el.audio.play();
            } else if (this.repeatMode === 'LOOP') {
                this.nextTrack();
            } else if (this.repeatMode === 'OFF') {
                if (this.playingIndex < this.playingPlaylist.length - 1) {
                    this.nextTrack();
                } else {
                    this.el.mcPlayPause.textContent = '▶️';
                }
            }
        },

        moveMusicControls: function () {
            var clockPos = {
                bottom: el.clockOverlay.style.bottom,
                right: el.clockOverlay.style.right,
                top: el.clockOverlay.style.top,
                left: el.clockOverlay.style.left
            };

            this.el.mcOverlay.style.top = 'auto';
            this.el.mcOverlay.style.bottom = 'auto';
            this.el.mcOverlay.style.left = 'auto';
            this.el.mcOverlay.style.right = 'auto';

            if (clockPos.bottom !== 'auto' && clockPos.bottom !== '') {
                this.el.mcOverlay.style.bottom = (parseInt(clockPos.bottom) + 110) + 'px';
            } else if (clockPos.top !== 'auto' && clockPos.top !== '') {
                this.el.mcOverlay.style.top = (parseInt(clockPos.top) + 110) + 'px';
            }

            if (clockPos.right !== 'auto' && clockPos.right !== '') {
                this.el.mcOverlay.style.right = clockPos.right;
            } else if (clockPos.left !== 'auto' && clockPos.left !== '') {
                this.el.mcOverlay.style.left = clockPos.left;
            }
        }
    };

    // Start
    init();

})();
