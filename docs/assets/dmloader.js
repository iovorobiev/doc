/* ********************************************************************* */
/* Load and combine data that is split into archives                     */
/* ********************************************************************* */

var Combine = {
    _targets: [],
    _targetIndex: 0,
    // target: build target
    //  name: intended filepath of built object
    //  size: expected size of built object.
    //  data: combined data
    //  downloaded: total amount of data downloaded
    //  pieces: array of name, offset and data objects
    //  numExpectedFiles: total number of files expected in description
    //  lastRequestedPiece: index of last data file requested (strictly ascending)
    //  totalLoadedPieces: counts the number of data files received

    //MAX_CONCURRENT_XHR: 6,    // remove comment if throttling of XHR is desired.

    isCompleted: false,       // status of process

    _onCombineCompleted: [],    // signature: name, data.
    _onAllTargetsBuilt:[],      // signature: void
    _onDownloadProgress: [],    // signature: downloaded, total

    _totalDownloadBytes: 0,
    _archiveLocationFilter: function(path) { return "split" + path; },

    addProgressListener: function(callback) {
        if (typeof callback !== 'function') {
            throw "Invalid callback registration";
        }
        this._onDownloadProgress.push(callback);
    },

    addCombineCompletedListener: function(callback) {
        if (typeof callback !== 'function') {
            throw "Invalid callback registration";
        }
        this._onCombineCompleted.push(callback);
    },

    addAllTargetsBuiltListener: function(callback) {
        if (typeof callback !== 'function') {
            throw "Invalid callback registration";
        }
        this._onAllTargetsBuilt.push(callback);
    },

    // descriptUrl: location of text file describing files to be preloaded
    process: function(descriptUrl) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', descriptUrl);
        xhr.responseType = 'text';
        xhr.onload = function(evt) {
            Combine.onReceiveDescription(xhr);
        };
        xhr.send(null);
    },

    cleanUp: function() {
        this._targets =  [];
        this._targetIndex = 0;
        this.isCompleted = false;
        this._onCombineCompleted = [];
        this._onAllTargetsBuilt = [];
        this._onDownloadProgress = [];

        this._totalDownloadBytes = 0;
    },

    onReceiveDescription: function(xhr) {
        var json = JSON.parse(xhr.responseText);
        this._targets = json.content;
        this._totalDownloadBytes = 0;

        var targets = this._targets;
        for(var i=0; i<targets.length; ++i) {
            this._totalDownloadBytes += targets[i].size;
        }
        this.requestContent();
    },

    requestContent: function() {
        var target = this._targets[this._targetIndex];
        if (1 < target.pieces.length) {
            target.data = new Uint8Array(target.size);
        }
        var limit = target.pieces.length;
        if (typeof this.MAX_CONCURRENT_XHR !== 'undefined') {
            limit = Math.min(limit, this.MAX_CONCURRENT_XHR);
        }
        for (var i=0; i<limit; ++i) {
            this.requestPiece(target, i);
        }
    },

    requestPiece: function(target, index) {
        if (index <  target.lastRequestedPiece) {
            throw "Request out of order";
        }

        target.lastRequestedPiece = index;
        target.progress = {};

        var item = target.pieces[index];
        var xhr = new XMLHttpRequest();
        xhr.open('GET', this._archiveLocationFilter('/' + item.name), true);
        xhr.responseType = 'arraybuffer';
        xhr.onprogress = function(evt) {
           target.progress[item.name] = {total: 0, downloaded: 0};
            if (evt.total && evt.lengthComputable) {
                target.progress[item.name].total = evt.total;
            }
            if (evt.loaded && evt.lengthComputable) {
                target.progress[item.name].downloaded = evt.loaded;
                Combine.updateProgress(target);
            }
        };
        xhr.onload = function(evt) {
            item.data = new Uint8Array(xhr.response);
            item.dataLength = item.data.length;
            target.progress[item.name].total = item.dataLength;
            target.progress[item.name].downloaded = item.dataLength;
            Combine.copyData(target, item);
            Combine.onPieceLoaded(target, item);
            Combine.updateProgress(target);
            item.data = undefined;
        };
        xhr.send(null);
    },

    updateProgress: function(target) {
        var total_downloaded = 0;
        for (var p in target.progress) {
            total_downloaded += target.progress[p].downloaded;
        }
        for(i = 0; i<this._onDownloadProgress.length; ++i) {
            this._onDownloadProgress[i](total_downloaded, this._totalDownloadBytes);
        }
    },

    copyData: function(target, item) {
        if (1 == target.pieces.length) {
            target.data = item.data;
        } else {
            var start = item.offset;
            var end = start + item.data.length;
            if (0 > start) {
                throw "Buffer underflow";
            }
            if (end > target.data.length) {
                throw "Buffer overflow";
            }
            target.data.set(item.data, item.offset);
        }
    },

    onPieceLoaded: function(target, item) {
        if (typeof target.totalLoadedPieces === 'undefined') {
            target.totalLoadedPieces = 0;
        }
        ++target.totalLoadedPieces;
        if (target.totalLoadedPieces == target.pieces.length) {
            this.finalizeTarget(target);
            ++this._targetIndex;
            for (var i=0; i<this._onCombineCompleted.length; ++i) {
                this._onCombineCompleted[i](target.name, target.data);
            }
            if (this._targetIndex < this._targets.length) {
                this.requestContent();
            } else {
                this.isCompleted = true;
                for (i=0; i<this._onAllTargetsBuilt.length; ++i) {
                    this._onAllTargetsBuilt[i]();
                }
            }
        } else {
            var next = target.lastRequestedPiece + 1;
            if (next < target.pieces.length) {
                this.requestPiece(target, next);
            }
        }
    },

    finalizeTarget: function(target) {
        var actualSize = 0;
        for (var i=0;i<target.pieces.length; ++i) {
            actualSize += target.pieces[i].dataLength;
        }
        if (actualSize != target.size) {
            throw "Unexpected data size";
        }

        if (1 < target.pieces.length) {
            var output = target.data;
            var pieces = target.pieces;
            for (i=0; i<pieces.length; ++i) {
                var item = pieces[i];
                // Bounds check
                var start = item.offset;
                var end = start + item.dataLength;
                if (0 < i) {
                    var previous = pieces[i - 1];
                    if (previous.offset + previous.dataLength > start) {
                        throw "Segment underflow";
                    }
                }
                if (pieces.length - 2 > i) {
                    var next = pieces[i + 1];
                    if (end > next.offset) {
                        throw "Segment overflow";
                    }
                }
            }
        }
    }
};

/* ********************************************************************* */
/* Default splash and progress visualisation                             */
/* ********************************************************************* */

var DefaultProgress = {
    progress_id: "_defold-progress",
    bar_id: "_defold-progress-bar",
    status_id: "_defold-status",

    start : function (canvas) {
        /* Insert default progress bar and status */
        var div = '<div id="' + DefaultProgress.progress_id + '">' +
                    '<div id="' + DefaultProgress.bar_id + '">' +
                    '</div></div>' +
                    '<div id="' + DefaultProgress.status_id + '"></div>';

        canvas.insertAdjacentHTML('afterend', div);
        var status = document.getElementById(DefaultProgress.status_id);
        var bar = document.getElementById(DefaultProgress.bar_id);
        var progress = document.getElementById(DefaultProgress.progress_id);

        status.style.display = 'none';
        status.style.position = 'absolute';
        status.style.textAlign = 'center';
        status.style.fontWeight = '600';
        status.style.bottom = '0';
        status.style.left = '50%';
        status.style.transform = 'translateX(-50%)';
        status.style.backgroundColor = 'hsla(0, 0%, 100%, .75)';
        status.style.boxShadow = '-0.035px 2px 5px 0px rgba(46, 37, 22, 0.25)';
        status.style.padding = '6px 12px';

        progress.style.width = '100%';
        progress.style.position = 'absolute';
        progress.style.bottom = '0';
        bar.style.width = '50%';
        bar.style.height = '4px';
        bar.style.backgroundColor = '#3F7BBB';
        DefaultProgress.status = status;
        DefaultProgress.bar = bar;
        DefaultProgress.progress = progress;
     },

    progress: function (bytes_loaded, bytes_total, status) {
        var percentage = bytes_loaded / bytes_total * 100;
        DefaultProgress.bar.style.width = percentage + "%";
        if(status) {
            DefaultProgress.status.innerText = status;
            DefaultProgress.status.style.display = 'block';
        } else {
            DefaultProgress.status.innerText = '';
            DefaultProgress.status.style.display = 'none';
        }
    },

    done: function () {
        DefaultProgress.status.innerText = "Starting...";
        DefaultProgress.status.style.display = 'block';
    },

    end: function () {
        DefaultProgress.progress.parentElement.removeChild(DefaultProgress.progress);
        DefaultProgress.status.parentElement.removeChild(DefaultProgress.status);
    }
};

/* ********************************************************************* */
/* Default input override                                                */
/* ********************************************************************* */

var CanvasInput = {
    arrowKeysHandler : function(e) {
        switch(e.keyCode) {
            case 37: case 38: case 39:  case 40: // Arrow keys
            case 32: e.preventDefault(); e.stopPropagation(); // Space
            default: break; // do not block other keys
        }
    },

    onFocusIn : function(e) {
        window.addEventListener("keydown", CanvasInput.arrowKeysHandler, false);
    },

    onFocusOut: function(e) {
        window.removeEventListener("keydown", CanvasInput.arrowKeysHandler, false);
    },

    addToCanvas : function(canvas) {
        canvas.addEventListener("focus", CanvasInput.onFocusIn, false);
        canvas.addEventListener("blur", CanvasInput.onFocusOut, false);
        canvas.focus();
        CanvasInput.onFocusIn();
    }
};

/* ********************************************************************* */
/* Module is Emscripten namespace                                        */
/* ********************************************************************* */

var Module = {
    noInitialRun: true,

    _filesToPreload: [],
    _archiveLoaded: false,
    _preLoadDone: false,
    _waitingForArchive: false,

    // Persistent storage
    persistentStorage: true,
    _syncInProgress: false,
    _syncNeeded: false,
    _syncInitial: false,
    _syncMaxTries: 3,
    _syncTries: 0,

    print: function(text) { console.log(text); },
    printErr: function(text) { console.error(text); },

    setStatus: function(text) { console.log(text); },

    prepareErrorObject: function (err, url, line, column, errObj) {
        line = typeof line == "undefined" ? 0 : line;
        column = typeof column == "undefined" ? 0 : column;
        url = typeof url == "undefined" ? "" : url;
        var errorLine = url + ":" + line + ":" + column;

        var error = errObj || (typeof window.event != "undefined" ? window.event.error : "" ) || err || "Undefined Error";
        var message = "";
        var stack = "";
        var backtrace = "";

        if (typeof error == "object" && typeof error.stack != "undefined" && typeof error.message != "undefined") {
            stack = String(error.stack);
            message = String(error.message);
        } else {
            stack = String(error).split("\n");
            message = stack.shift();
            stack = stack.join("\n");
        }
        stack = stack || errorLine;

        var callLine = /at (\S+:\d*$)/.exec(message);
        if (callLine) {
            message = message.replace(/(at \S+:\d*$)/, "");
            stack = callLine[1] + "\n" + stack;
        }

        message = message.replace(/(abort\(.+\)) at .+/, "$1");
        stack = stack.replace(/\?{1}\S+(:\d+:\d+)/g, "$1");
        stack = stack.replace(/ *at (\S+)$/gm, "@$1");
        stack = stack.replace(/ *at (\S+)(?: \[as \S+\])? +\((.+)\)/g, "$1@$2");
        stack = stack.replace(/^((?:Object|Array)\.)/gm, "");
        stack = stack.split("\n");

        return { stack:stack, message:message };
    },

    hasWebGLSupport: function() {
        var webgl_support = false;
        try {
            var canvas = document.createElement("canvas");
            var gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
            if (gl && gl instanceof WebGLRenderingContext) {
                webgl_support = true;
            }
        } catch (error) {
            console.log("An error occurred while detecting WebGL support: " + error);
            webgl_support = false;
        }

        return webgl_support;
    },

    /**
    * Module.runApp - Starts the application given a canvas element id
    *
    * 'extra_params' is an optional object that can have the following fields:
    *
    *     'archive_location_filter':
    *         Filter function that will run for each archive path.
    *
    *     'unsupported_webgl_callback':
    *         Function that is called if WebGL is not supported.
    *
    *     'engine_arguments':
    *         List of arguments (strings) that will be passed to the engine.
    *
    *     'persistent_storage':
    *         Boolean toggling the usage of persistent storage.
    *
    *     'custom_heap_size':
    *         Number of bytes specifying the memory heap size.
    *
    *     'load_start':
    *         Function to call when download starts.
    *         function(canvas) { }
    *
    *     'load_progress':
    *         Function to call on download progress.
    *         function(bytes_downloaded, bytes_total, status)
    *
    *     'load_done':
    *         Function to call when download is done.
    *         function()
    *
    *     'load_end':
    *         Function to call when game is loaded and ready to start.
    *         function()
    *
    *     'game_start':
    *         Function to call right before game starts.
    *         function()
    *
    **/
    setParams: function(extra_params) {
        var params = {
            splash_image: undefined,
            archive_location_filter: function(path) { return 'split' + path; },
            unsupported_webgl_callback: undefined,
            engine_arguments: [],
            persistent_storage: true,
            custom_heap_size: undefined,
            load_start: DefaultProgress.start,
            load_progress: DefaultProgress.progress,
            load_done: DefaultProgress.done,
            load_end: DefaultProgress.end,
            game_start: function() {},
        };

        for (var k in extra_params) {
            if (extra_params.hasOwnProperty(k)) {
                params[k] = extra_params[k];
            }
        }

        Module.archive_location_filter = params["archive_location_filter"];
        Module.arguments = params["engine_arguments"];
        Module.persistentStorage = params["persistent_storage"];
        Module["TOTAL_MEMORY"] = params["custom_heap_size"];
        Module.load_start = params["load_start"];
        Module.load_progress = params["load_progress"];
        Module.load_done = params["load_done"];
        Module.load_end = params["load_end"];
        Module.game_start = params["game_start"];
    },

    runApp: function(app_canvas_id, extra_params) {
        app_canvas_id = (typeof app_canvas_id === 'undefined') ?  'canvas' : app_canvas_id;
        Module.canvas = document.getElementById(app_canvas_id);

        Module.setParams(extra_params);

        if (Module.hasWebGLSupport()) {
            // Override game keys
            CanvasInput.addToCanvas(Module.canvas);

            // Load Facebook API
            var fb = document.createElement('script');
            fb.type = 'text/javascript';
            fb.src = '//connect.facebook.net/en_US/sdk.js';
            document.head.appendChild(fb);

            // Add progress
            Module.load_start(Module.canvas);

            // Load and assemble archive
            Combine.addCombineCompletedListener(Module.onArchiveFileLoaded);
            Combine.addAllTargetsBuiltListener(Module.onArchiveLoaded);
            Combine.addProgressListener(Module.onArchiveLoadProgress);
            Combine._archiveLocationFilter = Module.archive_location_filter;
            Combine.process(Combine._archiveLocationFilter('/archive_files.json'));
        } else {
            Module.load_start(Module.canvas);
            Module.load_progress(0, 0, "Unable to start game, WebGL not supported");
            Module.setStatus = function(text) {
                if (text) Module.printErr('[missing WebGL] ' + text);
            };

            if (typeof params["unsupported_webgl_callback"] === "function") {
                params["unsupported_webgl_callback"]();
            }
        }
    },
    /* Simulate app loading etc for frontend testing */
    testApp: function(app_canvas_id, extra_params) {
        app_canvas_id = (typeof app_canvas_id === 'undefined') ?  'canvas' : app_canvas_id;
        Module.canvas = document.getElementById(app_canvas_id);

        Module.setParams(extra_params);

        // Test progress
        Module._test_inc = 1;
        Module._test_bytes = 0;
        Module._test_total_bytes = 1000;
        Module.load_start(Module.canvas);
        Module._testintervall = setInterval(Module.testUpdate, 10);
    },

    testUpdate: function() {
        Module._test_bytes += Module._test_inc;
        var msg = undefined;
        var rat = Module._test_bytes / Module._test_total_bytes;
        if (rat > 0.3 && rat < 0.9) {
            msg = "Looking good so far";
            if (rat > 0.5) {
                msg = "If something bad happens, this is how it's presented.";
            }
        }
        if (Module._test_bytes < Module._test_total_bytes) {
            Module.load_progress(Module._test_bytes, Module._test_total_bytes, msg);
        } else {
            Module.load_done();
            clearInterval(Module._testintervall);
            setTimeout(Module.load_end, 2000);
            setTimeout(Module.game_start, 3000);
        }
    },

    onArchiveLoadProgress: function(downloaded, total) {
        Module.load_progress(downloaded, total);
    },

    onArchiveFileLoaded: function(name, data) {
        Module._filesToPreload.push({path: name, data: data});
    },

    onArchiveLoaded: function() {
        Combine.cleanUp();
        Module._archiveLoaded = true;

        Module.load_done();

        if (Module._waitingForArchive) {
            Module._preloadAndCallMain();
        }
    },

    toggleFullscreen: function() {
        if (GLFW.isFullscreen) {
            GLFW.cancelFullScreen();
        } else {
            GLFW.requestFullScreen();
        }
    },

    preSync: function(done) {
        // Initial persistent sync before main is called
        FS.syncfs(true, function(err) {
            if(err) {
                Module._syncTries += 1;
                console.error("FS syncfs error: " + err);
                if (Module._syncMaxTries > Module._syncTries) {
                    Module.preSync(done);
                } else {
                    Module._syncInitial = true;
                    done();
                }
            } else {
                Module._syncInitial = true;
                if (done !== undefined) {
                    done();
                }
            }
        });
    },

    preloadAll: function() {
        if (Module._preLoadDone) {
            return;
        }
        for (var i = 0; i < Module._filesToPreload.length; ++i) {
            var item = Module._filesToPreload[i];
            FS.createPreloadedFile("", item.path, item.data, true, true);
        }
        Module._preLoadDone = true;
    },

    // Tries to do a MEM->IDB sync
    // It will flag that another one is needed if there is already one sync running.
    persistentSync: function() {

        // Need to wait for the initial sync to finish since it
        // will call close on all its file streams which will trigger
        // new persistentSync for each.
        if (Module._syncInitial) {
            if (Module._syncInProgress) {
                Module._syncNeeded = true;
            } else {
                Module._startSyncFS();
            }
        }
    },

    preInit: [function() {
        /* Mount filesystem on preinit */
        var dir = DMSYS.GetUserPersistentDataRoot();
        FS.mkdir(dir);

        // If IndexedDB is supported we mount the persistent data root as IDBFS,
        // then try to do a IDB->MEM sync before we start the engine to get
        // previously saved data before boot.
        window.indexedDB = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
        if (Module.persistentStorage && window.indexedDB) {
            FS.mount(IDBFS, {}, dir);

            // Patch FS.close so it will try to sync MEM->IDB
            var _close = FS.close; FS.close = function(stream) { var r = _close(stream); Module.persistentSync(); return r; }

            // Sync IDB->MEM before calling main()
            Module.preSync(function() {
                Module._preloadAndCallMain();
            });
        } else {
            Module._preloadAndCallMain();
        }
    }],

    preRun: [function() {
        /* If archive is loaded, preload all its files */
        if(Module._archiveLoaded) {
            Module.preloadAll();
        }
    }],

    _preloadAndCallMain: function() {
        // If the archive isn't loaded,
        // we will have to wait with calling main.
        if (!Module._archiveLoaded) {
            Module._waitingForArchive = true;
        } else {

            // Need to set heap size before calling main
            TOTAL_MEMORY = Module["TOTAL_MEMORY"] || TOTAL_MEMORY;

            Module.preloadAll();
            Module.load_end();
            Module.game_start();
            Module.callMain(Module.arguments);
        }
    },

    // Wrap IDBFS syncfs call with logic to avoid multiple syncs
    // running at the same time.
    _startSyncFS: function() {
        Module._syncInProgress = true;

        if (Module._syncMaxTries > Module._syncTries) {
            FS.syncfs(false, function(err) {
                Module._syncInProgress = false;

                if (err) {
                    console.error("Module._startSyncFS error: " + err);
                    Module._syncTries += 1;
                }

                if (Module._syncNeeded) {
                    Module._syncNeeded = false;
                    Module._startSyncFS();
                }

            });
        }
    },
};

window.onerror = function(err, url, line, column, errObj) {
    var errorObject = Module.prepareErrorObject(err, url, line, column, errObj);
    Module.ccall('JSWriteDump', 'null', ['string'], [JSON.stringify(errorObject.stack)]);
    Module.setStatus('Exception thrown, see JavaScript console');
    Module.setStatus = function(text) {
        if (text) Module.printErr('[post-exception status] ' + text);
    };
};