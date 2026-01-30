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
        timer: null
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

    function fetchAssets(callback) {
        var albumIds = CONFIG.albumId ? CONFIG.albumId.split(',') : [];
        // Clean up whitespace
        albumIds = albumIds.map(function (id) { return id.trim(); }).filter(function (id) { return id.length > 0; });

        var allAssets = [];
        var completedRequests = 0;
        var totalRequests = albumIds.length; // 0 if favs

        // If no albums, defaults to 1 request (Favorites)
        if (totalRequests === 0) totalRequests = 1;

        function checkDone() {
            completedRequests++;
            if (completedRequests >= totalRequests) {
                if (allAssets.length === 0) {
                    showError('No images found in any provided albums.', true);
                    handleNetworkError();
                } else {
                    callback(allAssets);
                }
            }
        }

        function fetchUrl(url) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        var data = JSON.parse(xhr.responseText);
                        var assets = [];
                        if (data.assets) assets = data.assets;
                        else if (Array.isArray(data)) assets = data;

                        var images = assets.filter(function (asset) {
                            return asset.type === 'IMAGE';
                        });

                        allAssets = allAssets.concat(images);
                    } catch (e) {
                        showError('JSON Parse Error: ' + e.message, true);
                        console.error(e);
                        handleNetworkError();
                    }
                } else {
                    console.error('Server Error ' + xhr.status + ' for ' + url);
                    // Don't show error immediately on partial failure, unless all fail
                    handleNetworkError();
                }
                checkDone();
            };
            xhr.onerror = function () {
                console.error('Network error for ' + url);
                handleNetworkError();
                checkDone();
            };
            xhr.send();
        }

        if (albumIds.length > 0) {
            for (var i = 0; i < albumIds.length; i++) {
                log('Fetching album: ' + albumIds[i]);
                fetchUrl('/api/proxy/albums/' + albumIds[i]);
            }
        } else {
            log('Fetching favorites (default)');
            fetchUrl('/api/proxy/asset?take=100&isFavorite=true');
        }
    }

    function getAssetUrl(assetId) {
        // User requested full quality Original asset
        // Requires 'asset.download' permission
        return '/api/proxy/assets/' + assetId + '/original';
    }

    // --- Slideshow Logic ---

    function startSlideshow(assets) {
        state.assets = shuffleArray(assets);
        log('Loaded ' + state.assets.length + ' images');

        hideLoading();

        // Show Clock
        el.clockOverlay.classList.remove('hidden');
        updateClock();
        setInterval(updateClock, 1000 * 60);

        // Initial Slide
        showSlide(0);

        // Start Timer
        state.timer = setInterval(function () {
            nextSlide();
        }, CONFIG.interval * 1000);
    }

    function showSlide(index) {
        var asset = state.assets[index];
        if (!asset) return;

        var imgUrl = getAssetUrl(asset.id);

        // Preload image
        var img = new Image();
        img.onload = function () {
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
        };
        img.src = imgUrl; // Start loading
    }

    function nextSlide() {
        var next = (state.currentIndex + 1) % state.assets.length;
        // Watchdog tick
        updateLastSlideTime();
        showSlide(next);

        // Refresh assets occasionally? (e.g. end of cycle)
        if (next === 0) {
            // cycle complete, maybe re-shuffle or re-fetch?
            // For now just loop
        }
    }

    function prevSlide() {
        var prev = (state.currentIndex - 1 + state.assets.length) % state.assets.length;
        // Watchdog tick
        updateLastSlideTime();
        showSlide(prev);
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
                nextSlide();
            } else if (e.key === 'ArrowLeft' || e.key === 'Left') {
                prevSlide();
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
                    nextSlide();
                } else {
                    // Swiped right, show previous
                    prevSlide();
                }
            }
        }

        fetchAssets(function (assets) {
            startSlideshow(assets);
        });
    }

    function updateLastSlideTime() {
        lastSlideChange = Date.now();
        consecutiveFailures = 0; // Reset network errors on success
    }

    // Start
    init();

})();
