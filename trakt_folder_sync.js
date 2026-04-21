(function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Trakt Folder Sync
    // Двусторонняя синхронизация нативных папок Lampa с Trakt
    //
    // book  (Закладки)  <-->  Trakt Watchlist
    // thrown (Брошено)  <-->  Trakt My List (выбирается в настройках)
    // -----------------------------------------------------------------------

    var SYNC_TAG = 'TraktFolderSync';

    // Ключи Storage
    var STORAGE_THROWN_LIST_ID   = 'trakt_sync_thrown_list_id';
    var STORAGE_THROWN_LIST_NAME = 'trakt_sync_thrown_list_name';
    var STORAGE_ENABLED          = 'trakt_folder_sync_enabled';

    // Карта: ключ Lampa → тип Trakt ('watchlist' | list id)
    // thrown_list_id заполняется из настроек
    var FOLDER_MAP = {
        book:   'watchlist',
        thrown: null   // заполняется из Storage при инициализации
    };

    // ----- helpers ----------------------------------------------------------

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
        try {
            if (window.TraktTV && window.TraktTV.api) return window.TraktTV.api;
        } catch (e) {}
        return null;
    }

    // Нормализация карточки для сравнения и добавления
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

    // ----- Lampa → Trakt ----------------------------------------------------

    function onFavoriteEvent(e) {
        if (!isEnabled()) return;
        // e.type: 'add' | 'remove'
        // e.name: тип папки ('book', 'thrown', ...)
        // e.card: объект карточки
        if (!e || !e.card) return;

        var folder = e.name;
        if (folder !== 'book' && folder !== 'thrown') return;

        var api = getTraktApi();
        if (!api) return;

        var params = buildSyncParams(e.card);
        log('Favorite event', { type: e.type, folder: folder, id: cardTmdbId(e.card) });

        if (folder === 'book') {
            if (e.type === 'add') {
                api.addToWatchlist(params)
                    .then(function () { log('Added to Watchlist', cardTmdbId(e.card)); })
                    .catch(function (err) { log('addToWatchlist error', err); });
            } else if (e.type === 'remove') {
                api.removeFromWatchlist(params)
                    .then(function () { log('Removed from Watchlist', cardTmdbId(e.card)); })
                    .catch(function (err) { log('removeFromWatchlist error', err); });
            }
        } else if (folder === 'thrown') {
            var listId = Lampa.Storage.get(STORAGE_THROWN_LIST_ID);
            if (!listId) {
                log('thrown list not configured, skip');
                return;
            }
            if (e.type === 'add') {
                api.addToList({ listId: listId, item: params })
                    .then(function () { log('Added to thrown list', cardTmdbId(e.card)); })
                    .catch(function (err) { log('addToList error', err); });
            } else if (e.type === 'remove') {
                api.removeFromList({ listId: listId, item: params })
                    .then(function () { log('Removed from thrown list', cardTmdbId(e.card)); })
                    .catch(function (err) { log('removeFromList error', err); });
            }
        }
    }

    // ----- Trakt → Lampa (при открытии папки) --------------------------------

    // Флаги чтобы не запускать сверку параллельно
    var syncInProgress = { book: false, thrown: false };

    function syncTraktToLampa(folder) {
        if (!isEnabled()) return;
        if (syncInProgress[folder]) return;

        var api = getTraktApi();
        if (!api) return;

        var token = Lampa.Storage.get('trakt_token');
        if (!token) return;

        syncInProgress[folder] = true;
        log('Start sync Trakt→Lampa', folder);

        fetchAllTraktItems(api, folder)
            .then(function (traktItems) {
                applyTraktToLampa(folder, traktItems);
            })
            .catch(function (err) {
                log('fetchAllTraktItems error', err);
            })
            .finally(function () {
                syncInProgress[folder] = false;
            });
    }

    // Загрузить все элементы из Trakt для данной папки (все страницы)
    function fetchAllTraktItems(api, folder) {
        if (folder === 'book') {
            return fetchAllPages(function (page) {
                return api.watchlist({ page: page, limit: 100, mediaType: 'movies,shows' });
            });
        } else if (folder === 'thrown') {
            var listId = Lampa.Storage.get(STORAGE_THROWN_LIST_ID);
            if (!listId) return Promise.resolve([]);
            return fetchAllPages(function (page) {
                return api.myListItems({ listId: listId, page: page, limit: 100 });
            });
        }
        return Promise.resolve([]);
    }

    function fetchAllPages(fetchFn) {
        var all = [];
        function next(page) {
            return fetchFn(page).then(function (data) {
                var results = (data && data.results) ? data.results : [];
                all = all.concat(results);
                var totalPages = (data && data.total_pages) ? data.total_pages : 1;
                if (page < totalPages) return next(page + 1);
                return all;
            });
        }
        return next(1);
    }

    // Сравнить Trakt-список с нативной папкой и применить разницу
    function applyTraktToLampa(folder, traktItems) {
        var localItems = Lampa.Favorite.get({ type: folder }) || [];

        // Строим Set TMDB id из локальных
        var localIds = new Set(localItems.map(cardTmdbId).filter(Boolean));

        // Строим Set TMDB id из Trakt
        var traktIds = new Set(traktItems.map(cardTmdbId).filter(Boolean));

        var added = 0, removed = 0;

        // Есть в Trakt, нет в Lampa → добавить в Lampa
        traktItems.forEach(function (card) {
            var id = cardTmdbId(card);
            if (!id) return;
            if (!localIds.has(id)) {
                try {
                    Lampa.Favorite.add(folder, card);
                    added++;
                } catch (e) { log('Favorite.add error', e); }
            }
        });

        // Есть в Lampa, нет в Trakt → удалить из Lampa
        // Используем тихое удаление без триггера события (чтобы не вызвать loop)
        localItems.forEach(function (card) {
            var id = cardTmdbId(card);
            if (!id) return;
            if (!traktIds.has(id)) {
                try {
                    silentRemoveFromFavorite(folder, card);
                    removed++;
                } catch (e) { log('Favorite.remove error', e); }
            }
        });

        log('Sync done', { folder: folder, added: added, removed: removed });
        if (added || removed) {
            Lampa.Activity.active() && Lampa.Activity.active().refresh &&
                Lampa.Activity.active().refresh();
        }
    }

    // Удаление из нативной папки без генерации события favorite,
    // чтобы не создавать loop Lampa→Trakt при удалении по инициативе Trakt→Lampa
    var _suppressFavoriteEvent = false;

    function silentRemoveFromFavorite(type, card) {
        _suppressFavoriteEvent = true;
        try {
            Lampa.Favorite.remove(type, card);
        } finally {
            _suppressFavoriteEvent = false;
        }
    }

    // ----- Перехват открытия нативных папок ----------------------------------

    function hookFavoriteOpen() {
        // Lampa генерирует событие 'activity' при открытии компонента
        // Компонент папок — 'favorite', параметр type — тип папки
        Lampa.Listener.follow('activity', function (e) {
            if (!e || e.type !== 'start') return;
            var activity = e.object || {};
            if (activity.component !== 'favorite') return;
            var folder = activity.type;
            if (folder === 'book' || folder === 'thrown') {
                // Небольшая задержка чтобы папка успела отрисоваться
                setTimeout(function () {
                    syncTraktToLampa(folder);
                }, 500);
            }
        });
    }

    // ----- Настройки --------------------------------------------------------

    function addSettings() {
        // Раздел уже есть ('trakt'), добавляем параметры в него

        // Переключатель синхронизации
        Lampa.SettingsApi.addParam({
            component: 'trakt',
            param: {
                name: STORAGE_ENABLED,
                type: 'trigger',
                'default': true
            },
            field: {
                name: 'Синхронизация нативных папок',
                description: 'Закладки ↔ Watchlist, Брошено ↔ выбранный список'
            }
        });

        // Выбор списка для "Брошено"
        Lampa.SettingsApi.addParam({
            component: 'trakt',
            param: {
                name: 'trakt_sync_thrown_select',
                type: 'button'
            },
            field: {
                name: 'Список Trakt для папки «Брошено»',
                description: Lampa.Storage.get(STORAGE_THROWN_LIST_NAME) || 'Не выбран'
            },
            onRender: function (item) {
                // Обновляем description актуальным значением
                var name = Lampa.Storage.get(STORAGE_THROWN_LIST_NAME) || 'Не выбран';
                item.find('.settings-param__description').text(name);
                if (!Lampa.Storage.get('trakt_token')) item.hide();
                else item.show();
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
                            title: list.list_title || list.title || String(list.id),
                            listId: list.id,
                            listName: list.list_title || list.title || String(list.id)
                        };
                    });
                    items.push({ title: 'Отмена', cancel: true });
                    Lampa.Select.show({
                        title: 'Список для «Брошено»',
                        items: items,
                        onSelect: function (item) {
                            if (item.cancel) {
                                Lampa.Controller.toggle('settings_component');
                                return;
                            }
                            Lampa.Storage.set(STORAGE_THROWN_LIST_ID, item.listId);
                            Lampa.Storage.set(STORAGE_THROWN_LIST_NAME, item.listName);
                            Lampa.Bell.push({ text: 'Список «' + item.listName + '» выбран для Брошено' });
                            Lampa.Settings.update();
                            Lampa.Controller.toggle('settings_component');
                        },
                        onBack: function () {
                            Lampa.Controller.toggle('settings_component');
                        }
                    });
                }).catch(function () {
                    Lampa.Bell.push({ text: 'Ошибка загрузки списков Trakt' });
                });
            }
        });
    }

    // ----- Инициализация ----------------------------------------------------

    function init() {
        // Monkey-patch Lampa.Favorite.add / remove
        var _origAdd    = Lampa.Favorite.add.bind(Lampa.Favorite);
        var _origRemove = Lampa.Favorite.remove.bind(Lampa.Favorite);

        Lampa.Favorite.add = function (type, card) {
            var result = _origAdd(type, card);
            if (!_suppressFavoriteEvent && (type === 'book' || type === 'thrown')) {
                onFavoriteEvent({ type: 'add', name: type, card: card });
            }
            return result;
        };

        Lampa.Favorite.remove = function (type, card) {
            var result = _origRemove(type, card);
            if (!_suppressFavoriteEvent && (type === 'book' || type === 'thrown')) {
                onFavoriteEvent({ type: 'remove', name: type, card: card });
            }
            return result;
        };

        // Перехват открытия папки
        hookFavoriteOpen();

        log('Initialized');
    }

    // Запуск: либо сразу если приложение готово, либо ждём
    function start() {
        if (window.appready) {
            addSettings();
            init();
        } else {
            Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') {
                    addSettings();
                    init();
                }
            });
        }
    }

    if (!window.plugin_trakt_folder_sync_ready) {
        window.plugin_trakt_folder_sync_ready = true;
        start();
    }

})();
