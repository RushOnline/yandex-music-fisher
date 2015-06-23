/* global storage, yandex, chrome, logger, utils */
'use strict';

var downloader = {
    queue: [],
    downloads: [],
    activeThreadCount: 0
};

downloader.download = function () {
    if (storage.current.downloadThreadCount === downloader.activeThreadCount) {
        return; // достигнуто максимальное количество потоков загрузки
    }
    var entity = downloader.queue.shift();
    if (!entity) { // в очереди нет загрузок
        return;
    }
    var trackTypes = ['track', 'album_track', 'playlist_track'];
    var isTrack = (trackTypes.indexOf(entity.type) > -1);
    var isCover = (entity.type === 'cover');
    if (isTrack) {
        downloader.activeThreadCount++;
        var track = entity.track;
        var trackNameMask = storage.current.trackNameMask;
        var artists = utils.parseArtists(track.artists);
        if (track.version) {
            track.title += ' (' + track.version + ')';
        }
        var savePath = trackNameMask.replace('#НАЗВАНИЕ#', track.title);
        savePath = savePath.replace('#ИСПОЛНИТЕЛИ#', artists);
        if (storage.current.shouldNumberLists && entity.namePrefix) {
            savePath = entity.namePrefix + ' ' + savePath;
        }
        savePath = utils.clearPath(savePath) + '.mp3';
        if (entity.saveDir) {
            savePath = entity.saveDir + '/' + savePath;
        }
        yandex.getTrackUrl(track.storageDir, function (url) {
            utils.ajax(url, 'arraybuffer', function (arrayBuffer) {
                var frames = {
                    TIT2: track.title, // Title/songname/content description
                    TPE1: artists, // Lead performer(s)/Soloist(s)
                    TALB: track.albums[0].title, // Album/Movie/Show title
                    TYER: track.albums[0].year, // Year
                    TCON: track.albums[0].genre // Content type
                };
                if (entity.type === 'album_track') {
                    // todo: ставить не порядковый номер, а из альбома
                    frames.TRCK = entity.namePrefix; // Track number/Position in set
                }
                var localUrl = utils.addId3Tag(arrayBuffer, frames);

                chrome.downloads.download({
                    url: localUrl,
                    filename: savePath,
                    saveAs: false
                }, function (downloadId) {
                    downloader.downloads[downloadId] = entity;
                });
            }, function (error) {
                logger.addMessage(error);
            }, function (event) {
                console.info(event.loaded + ' / ' + event.total);
            });
        }, function (error) {
            logger.addMessage(error);
            downloader.activeThreadCount--;
            downloader.download();
        });
    } else if (isCover) {
        downloader.activeThreadCount++;
        chrome.downloads.download({
            url: entity.url,
            filename: entity.filename,
            saveAs: false
        }, function (downloadId) {
            downloader.downloads[downloadId] = entity;
        });
    }
};

downloader.downloadTrack = function (trackId) {
    yandex.getTrack(trackId, function (track) {
        downloader.queue.push({
            type: 'track',
            track: track
        });
        downloader.download();
    }, logger.addMessage);
};

downloader.downloadAlbum = function (albumId, discographyArtist) {
    yandex.getAlbum(albumId, function (album) {
        if (!album.volumes.length) {
            logger.addMessage('Пустой альбом. album.id:' + album.id);
            return;
        }
        var artists = utils.parseArtists(album.artists);
        if (album.version) {
            album.title += ' (' + album.version + ')';
        }
        var saveDir = utils.clearPath(artists + ' - ' + album.title);
        if (discographyArtist) {
            saveDir = utils.clearPath(discographyArtist) + '/' + saveDir;
        }

        if (storage.current.shouldDownloadCover && album.coverUri) {
            downloader.queue.push({
                type: 'cover',
                url: 'https://' + album.coverUri.replace('%%', storage.current.albumCoverSize),
                filename: saveDir + '/cover.jpg'
            });
            downloader.download();
        }

        for (var i = 0; i < album.volumes.length; i++) {
            for (var j = 0; j < album.volumes[i].length; j++) {
                var track = album.volumes[i][j];
                if (track.error) { // todo: проверить, если ли сейчас такое поле
                    logger.addMessage('Ошибка: ' + track.error + '. trackId: ' + track.id);
                    continue;
                }
                var saveCdDir = saveDir;
                if (album.volumes.length > 1) {
                    // пример: https://music.yandex.ru/album/2490723
                    saveCdDir += '/CD' + (i + 1);
                }
                downloader.queue.push({
                    type: 'album_track',
                    track: track,
                    saveDir: saveCdDir,
                    namePrefix: utils.addExtraZeros(j + 1, album.volumes[i].length)
                });
                downloader.download();
            }
        }
    }, logger.addMessage);
};

downloader.downloadPlaylist = function (username, playlistId) {
    yandex.getPlaylist(username, playlistId, function (playlist) {
        if (!playlist.tracks.length) {
            var message = 'Пустой плейлист. playlist.owner.login: ';
            message += playlist.owner.login + ', playlist.kind: ' + playlist.kind;
            logger.addMessage(message);
            return;
        }

        for (var i = 0; i < playlist.tracks.length; i++) {
            var track = playlist.tracks[i];
            if (track.error) {
                logger.addMessage('Ошибка: ' + track.error + '. trackId: ' + track.id);
                continue;
            }
            downloader.queue.push({
                type: 'playlist_track',
                track: track,
                saveDir: utils.clearPath(playlist.title),
                namePrefix: utils.addExtraZeros(i + 1, playlist.tracks.length)
            });
            downloader.download();
        }
    }, logger.addMessage);
};
