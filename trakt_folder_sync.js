(function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Trakt Folder Sync
    // Двусторонняя синхронизация нативных папок Lampa с Trakt
    //
    // book   (Закладки) <--> Trakt Watchlist
    // thrown (Брошено)  <--> Trakt My List (выбирается в настройках)
    // -----------------------------------------------------------------------

    var SYNC_TAG = 'TraktFolderSync';

    var STORAGE_THROWN_LIST_ID   = 'trakt_sync_thrown_list_id';
    var STORAGE_THROWN_LIST_NAME = 'trakt_sync_thrown_list_name';
    var STORAGE_ENABLED          = 'trakt_folder_sync_enabled';

    function log(msg, data) {
        if (!Lampa.Storage.field('trakt_enable_logging')) return;
        if (data !== undefined) console.log(SYNC_TAG, msg, data);
        else console.log(SYNC_TAG, msg);
    }

    function isEnabled() {
        return !!(
            Lampa.Storage.get('trakt_token') &&
            Lampa.Storage.field(STORAGE_ENABLED) !== false
        );
    }

    function getTraktApi() {
        try { if (window.TraktTV && window.TraktTV.api) return window.TraktTV.api; }
        catch (e) {}
        return null;
    }

    function cardTmdbId(card) {
        if (!card) return null;
        var id = (card.ids && card.ids.tmdb) || card.id;
        return id ? String(id) : null;
    }

    function buildSyncParams(card) {
        var method = card.method || card.card_type || card.type ||
                     (card.first_air_date || card.name ? 'tv' : 'movie');
        var ids = Object.assign({}, card.ids || {});
        if (!ids.tmdb && card.id) ids.tmdb = card.id;
        return { method: method, ids: ids, id: card.id };
    }

    // ----- Lampa -> Trakt ---------------------------------------------------

    var _suppressEvent = false;

    function onFavoriteChanged(folder, method, card) {
        if (!isEnabled()) return;
        var api = getTraktApi();
        if (!api) return;
        var params = buildSyncParams(card);
        log('Lampa->Trakt', { folder: folder, method: method, id: cardTmdbId(card) });

        if (folder === 'book') {
            if (method === 'add') {
                api.addToWatchlist(params)
                    .then(function () { log('Added to Watchlist'); })
                    .catch(function (e) { log('addToWatchlist error', e); });
            } else {
                api.removeFromWatchlist(params)
                    .then(function () { log('Removed from Watchlist'); })
                    .catch(function (e) { log('removeFromWatchlist error', e); });
            }
        } else if (folder === 'thrown') {
            var listId = Lampa.Storage.get(STORAGE_THROWN_LIST_ID);
            if (!listId) { log('thrown list not configured'); return; }
            if (method === 'add') {
                api.addToList({ listId: listId, item: params })
                    .then(function () { log('Added to thrown list'); })
                    .catch(function (e) { log('addToList error', e); });
            } else {
                api.removeFromList({ listId: listId, item: params })
                    .then(function () { log('Removed from thrown list'); })
                    .catch(function (e) { log('removeFromList error', e); });
            }
        }
    }

    // ----- Trakt -> Lampa ---------------------------------------------------

    var syncInProgress = { book: false, thrown: false };

    function syncTraktToLampa(folder) {
        if (!isEnabled() || syncInProgress[folder]) return;
        var api = getTraktApi();
        if (!api) return;
        syncInProgress[folder] = true;
        log('Start sync Trakt->Lampa', folder);
        fetchAllTraktItems(api, folder)
            .then(function (items) { applyTraktToLampa(folder, items); })
            .catch(function (e) { log('sync error', e); })
            .then(function () { syncInProgress[folder] = false; });
    }

    function fetchAllTraktItems(api, folder) {
        if (folder === 'book') {
            return fetchAllPages(function (p) {
                return api.watchlist({ page: p, limit: 100, mediaType: 'movies,shows' });
            });
        }
        if (folder === 'thrown') {
            var listId = Lampa.Storage.get(STORAGE_THROWN_LIST_ID);
            if (!listId) return Promise.resolve([]);
            return fetchAllPages(function (p) {
                return api.myListItems({ listId: listId, page: p, limit: 100 });
            });
        }
        return Promise.resolve([]);
    }

    function fetchAllPages(fn) {
        var all = [];
        function next(page) {
            return fn(page).then(function (data) {
                var results = (data && data.results) ? data.results : [];
                all = all.concat(results);
                if (page < ((data && data.total_pages) || 1)) return next(page + 1);
                return all;
            });
        }
        return next(1);
    }

    function applyTraktToLampa(folder, traktItems) {
        var localItems = Lampa.Favorite.get({ type: folder }) || [];
        var localIds   = new Set(localItems.map(cardTmdbId).filter(Boolean));
        var traktIds   = new Set(traktItems.map(cardTmdbId).filter(Boolean));
        var added = 0, removed = 0;

        _suppressEvent = true;
        try {
            traktItems.forEach(function (card) {
                var id = cardTmdbId(card);
                if (!id || localIds.has(id)) return;
                try { Lampa.Favorite.add(folder, card); added++; }
                catch (e) { log('add error', e); }
            });
            localItems.forEach(function (card) {
                var id = cardTmdbId(card);
                if (!id || traktIds.has(id)) return;
                try { Lampa.Favorite.remove(folder, card); removed++; }
                catch (e) { log('remove error', e); }
            });
        } finally {
            _suppressEvent = false;
        }
        log('Sync done', { folder: folder, added: added, removed: removed });
    }

    // ----- Перехват открытия папки ------------------------------------------

    function hookFavoriteOpen() {
        Lampa.Listener.follow('activity', function (e) {
            if (!e || e.type !== 'start') return;
            var activity = e.object || {};
            if (activity.component !== 'favorite') return;
            var folder = activity.type;
            if (folder === 'book' || folder === 'thrown') {
                setTimeout(function () { syncTraktToLampa(folder); }, 500);
            }
        });
    }

    // ----- Настройки --------------------------------------------------------

    function addSettings() {
        Lampa.SettingsApi.addParam({
            component: 'trakt',
            param: { name: STORAGE_ENABLED, type: 'trigger', 'default': true },
            field: {
                name: 'Синхронизация нативных папок',
                description: 'Закладки <-> Watchlist, Брошено <-> выбранный список'
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'trakt',
            param: { name: 'trakt_sync_thrown_select', type: 'button' },
            field: {
                name: 'Список Trakt для папки "Брошено"',
                description: Lampa.Storage.get(STORAGE_THROWN_LIST_NAME) || 'Не выбран'
            },
            onRender: function (item) {
                var name = Lampa.Storage.get(STORAGE_THROWN_LIST_NAME) || 'Не выбран';
                item.find('.settings-param__description').text(name);
                if (!Lampa.Storage.get('trakt_token')) item.hide(); else item.show();
            },
            onChange: function () {
                var api = getTraktApi();
                if (!api) return;
                api.myLists({ page: 1, limit: 100 }).then(function (response) {
                    var lists = (response && response.results) ? response.results : [];
                    if (!lists.length) {
                        Lampa.Bell.push({ text: 'Нет личных списков в Trakt' });
                        return;
                    }
                    var items = lists.map(function (list) {
                        return {
                            title:    list.list_title || list.title || String(list.id),
                            listId:   list.id,
                            listName: list.list_title || list.title || String(list.id)
                        };
                    });
                    items.push({ title: 'Отмена', cancel: true });
                    Lampa.Select.show({
                        title: 'Список для "Брошено"',
                        items: items,
                        onSelect: function (item) {
                            if (item.cancel) { Lampa.Controller.toggle('settings_component'); return; }
                            Lampa.Storage.set(STORAGE_THROWN_LIST_ID,   item.listId);
                            Lampa.Storage.set(STORAGE_THROWN_LIST_NAME, item.listName);
                            Lampa.Bell.push({ text: 'Список "' + item.listName + '" выбран для Брошено' });
                            Lampa.Settings.update();
                            Lampa.Controller.toggle('settings_component');
                        },
                        onBack: function () { Lampa.Controller.toggle('settings_component'); }
                    });
                }).catch(function () {
                    Lampa.Bell.push({ text: 'Ошибка загрузки списков Trakt' });
                });
            }
        });
    }

    // ----- Инициализация ----------------------------------------------------

    function init() {
        // CUB генерирует 'state:changed' после успешной синхронизации с сервером
        // { target:'favorite', method:'add'/'remove', reason:'update', card:{...} }
        Lampa.Listener.follow('state', function (e) {
            if (_suppressEvent) return;
            if (!e || e.target !== 'favorite' || e.reason !== 'update') return;
            if (!e.card || !e.method) return;

            var cardId = cardTmdbId(e.card);
            if (!cardId) return;

            ['book', 'thrown'].forEach(function (folder) {
                var items    = Lampa.Favorite.get({ type: folder }) || [];
                var inFolder = items.some(function (c) { return cardTmdbId(c) === cardId; });

                if (e.method === 'add' && inFolder) {
                    onFavoriteChanged(folder, 'add', e.card);
                } else if (e.method === 'remove' && !inFolder) {
                    onFavoriteChanged(folder, 'remove', e.card);
                }
            });
        });

        hookFavoriteOpen();
        log('Initialized');
    }

    function start() {
        if (window.appready) { addSettings(); init(); }
        else {
            Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') { addSettings(); init(); }
            });
        }
    }

    if (!window.plugin_trakt_folder_sync_ready) {
        window.plugin_trakt_folder_sync_ready = true;
        start();
    }

})();
