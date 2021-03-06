import fs = require('fs');
import url = require('url');
import path = require('path');
var debug = require('debug')('site');
import util = require('./util');
import mfo = require('mf-obj');
import Publisher from './publisher';
import oembed = require('./oembed');
import posse = require('./posse');
import assert = require('assert');
import jade = require('jade');

var _renderEntry = jade.compileFile('template/entrypage.jade', {pretty:true});
var _renderStream = jade.compileFile('template/streampage.jade', {pretty:true});
var _renderReplyStream = jade.compileFile('template/replystreampage.jade', {pretty: true});
var _renderIndex = jade.compileFile('template/indexpage.jade', {pretty:true});

interface SiteConfig {
    title: string;
    url: string;
    author: {
        name: string;
        photo?: string;
        note?: string;
        elsewhere: {
            name: string;
            url: string;
        }[];
    }
    entriesPerPage: number;
    port: number;
    staticSiteRoot?: string;
    skelRoot?: string;
    keyFile?: string;
    certFile?: string;
    authUrl: string;
    tokenUrl: string;
    micropubUrl: string;
    webmentionUrl: string;
    publisher:
    {
        type: "file";
        root: string;
    } |
    {
       type: "git";
       root: string;
       push: boolean;
    } |
    {
        type: "s3";
        region: string;
        bucket: string;
    };
    password: string;
    jwtSecret: string;
}

interface Micropub {
    name?: string,
    content: string | {html: string},
    replyTo?: string,
    likeOf?: string,
    repostOf?: string,
    category?: string | string[],
    syndication?: string | string[],
    photo?: {filename: string, tmpfile: string, mimetype: string},
    audio?: {filename: string, tmpfile: string, mimetype: string},
    syndicateTo?: string | string[]
}

class Site {
    config: SiteConfig;
    publisher: Publisher;
    mutex: util.Mutex;
    entries: Map<string, mfo.Entry>;

    constructor(config: SiteConfig) {
        this.config = config;
        this.publisher = Publisher.getInstance(config.publisher);
        this.mutex = new util.Mutex();
        this.entries = new Map();
    }
    
    async init() {
        try {
            if (typeof this.config.skelRoot === 'string') {
                var files = await util.walkDir(this.config.skelRoot);
                await util.map(files, async (file) => {
                    debug('Copying ' + file);
                    await this.publisher.put(path.relative(this.config.skelRoot, file), fs.createReadStream(file));
                });
                await this.publisher.commit('Copy skel files');
            }
            await this.scan();
        } catch (err) {
            debug(err);
        }
    }
    
    formatDate(date) {
        var month = ["Jan","Feb","Mar","Apr","May","Jun",
            "Jul","Aug","Sep","Oct","Nov","Dec"];
        var minutes = date.getMinutes();
        return date.getDate() + ' ' +
            month[date.getMonth()] + ' ' +
            date.getFullYear() + ' ' +
            date.getHours() + ':' +
            ((minutes < 10) ? '0' + minutes : minutes);
    }

    async getNextAvailable(n, prefix) {
        while (await this.publisher.exists(prefix + n)) {
            n++;
        }
        return prefix + n;
    }

    getAuthor() {
        var card = new mfo.Card();
        card.url = this.config.url;
        card.name = this.config.author.name;
        card.photo = this.config.author.photo;
        return card;
    }

    renderEntry(entry: mfo.Entry) {
        return _renderEntry({
            site: this,
            entry: entry,
            util: util,
            microformat: mfo
        });
    }

    async publish(m: Micropub) {
        try {
            var release = await this.mutex.lock();
            var entry = new mfo.Entry();
            entry.author = this.getAuthor();
            // workaround: type guards dont work with properties
            // https://github.com/Microsoft/TypeScript/issues/3812
            var content = m.content;
            if (content == null)
                content = '';
            if (typeof content === 'string') {
                entry.name = m.name || content;
                entry.content = {
                    value: content,
                    html: '<div class="note-content">' + util.autoLink(util.escapeHtml(content)) + '</div>'
                };
            } else {
                entry.name = m.name || util.stripHtml(content.html);
                entry.content = {
                    value: util.stripHtml(content.html),
                    html: content.html
                };
            }
            entry.published = new Date();
            var slug = await this.getSlug(m.name, entry.published);
            entry.url = this.config.url + slug;
            var strategies: mfo.EntryStrategy[] = ['entry', 'event', 'oembed'];
            if (m.replyTo != null)
                entry.replyTo = [await mfo.getEntry(m.replyTo, strategies)];
            if (m.likeOf != null)
                entry.likeOf = [await mfo.getEntry(m.likeOf, strategies)];
            if (m.repostOf != null)
                entry.repostOf = [await mfo.getEntry(m.repostOf, strategies)];
            if (m.category != null) {
                let category = m.category;
                if (typeof category === 'string')
                    entry.category = [category];
                else if (typeof category === 'object')
                    entry.category = category;
            }
            if (m.syndication != null) {
                let syndication = m.syndication;
                if (typeof syndication === 'string')
                entry.syndication = [syndication];
                else if (typeof syndication === 'object')
                    entry.syndication = syndication;
            }
            if (m.syndicateTo != null) {
                var s = m.syndicateTo;
                if (typeof s === 'string')
                    entry.syndicateTo = [s];
                else if (typeof s === 'object')
                    entry.syndicateTo = s;
            }
            if (m.photo != null) {
                entry.content.html = '<div class="thumbnail"><img class="u-photo" src="' + m.photo.filename + '"/>' +
                '<div class="caption">' + entry.content.html + '</div></div>';
                await this.publisher.put(path.join(path.dirname(slug), m.photo.filename),
                fs.createReadStream(m.photo.tmpfile), m.photo.mimetype);
            }
            if (m.audio != null) {
                entry.content.html = '<div class="thumbnail"><audio class="u-audio" src="' + m.audio.filename + '" controls></audio>' +
                '<div class="caption">' + entry.content.html + '</div></div>';
                await this.publisher.put(path.join(path.dirname(slug), m.audio.filename),
                fs.createReadStream(m.audio.tmpfile), m.audio.mimetype);
            }
            for (let link of entry.getMentions()) {
                try {
                    let embed = await oembed(link);
                    if (entry.embed == null)
                        entry.embed = {html: '', value: ''};
                    entry.embed.html += embed;
                } catch (err) {
                    //debug(err.message);
                }
            }
            //ISSUE: some properties may be embedded mf in the content (e.g. summary)
            //so we render and then re-parse it to get all properties
            var html = this.renderEntry(entry);
            entry = await mfo.getEntryFromHtml(html, entry.url);
            await this.update(entry);
            if (entry.syndicateTo != null) {
                var syndications = await posse.syndicate(entry);
                entry.syndication = entry.syndication.concat(syndications);
                await this.update(entry);
            }
            await this.publisher.commit(util.truncate('[' + entry.author.name + '] ' + util.collapse(entry.name), 50) +
            '\n' + entry.url);
            release();
            await this.sendWebmentionsFor(entry);
            return entry;
        } finally {
            release();
        }
    }

    get(u: string) {
        var entry = this.entries.get(u);
        if (entry === undefined)
            throw new Error(u + ' not found');
        return entry;
    }
    
    getAll() {
        return Array.from(this.entries.values());
    }

    async scan() {
        var keys = await this.publisher.list();
        var entries: Map<string, mfo.Entry> = new Map();
        var re = /^(index|js|css|tags|articles|replies)/;
        keys = keys.filter(k => !re.test(k));
        await Promise.all(keys.map( async (key) => {
            let obj = await this.publisher.get(key);
            debug('Scanning ' + key);
            if (obj.ContentType === 'text/html') {
                let u = url.resolve(this.config.url, key);
                try {
                    let entry = await mfo.getEntryFromHtml(obj.Body, u);
                    if (entry != null && (entry.url === u || entry.url + '.html' === u)) {
                        entries.set(entry.url, entry);
                    }
                } catch (err) {}
            }
        }));
        debug('Done scanning');
        this.entries = entries;
    }

    async update(entry: mfo.Entry) {
        var html = this.renderEntry(entry);
        await this.publisher.put(entry.getPath(), html, 'text/html');
        this.entries.set(entry.url, entry);
        debug('Published ' + entry.getPath());
        await this.generateStreams();
        return entry;
    }

    async delete(url: string) {
        var entry = this.get(url);
        await this.publisher.delete(entry.getPath(), 'text/html');
        this.entries.delete(entry.url);
        debug('Deleted ' + entry.getPath());
        await this.generateStreams();
    }

    getPathForIndex(page) {
        return 'index' + (page == 1 ? '' : page);
    }

    getPathForTag(category) {
        return '/tags/' + util.kebabCase(category);
    }

    async _generateStream(entries: mfo.Entry[], page: number, total: number) {
        let html = _renderStream({
            site: this,
            entries: entries,
            page: page,
            totalPages: total,
            util: util
        });
        var file = this.getPathForIndex(page);
        await this.publisher.put(file, html, 'text/html');
        debug('Published ' + file);
    }

    async _generateReplyStream(entries: mfo.Entry[], page: number, total: number) {
        let html = _renderReplyStream({
            site: this,
            entries: entries,
            page: page,
            totalPages: total,
            util: util
        });
        var file = path.join('replies', this.getPathForIndex(page));
        await this.publisher.put(file, html, 'text/html');
        debug('Published ' + file);
    }

    async _generateIndex(entries: mfo.Entry[], category: string, path: string) {
        var html = _renderIndex({
            site: this,
            category: category,
            entries: entries,
            util: util
        });
        await this.publisher.put(path, html, 'text/html');
        debug('Published ' + path);
    }

    getSlug(name: string, date: Date) {
        var datepart = '/' + date.getFullYear() + '/' + (date.getMonth() + 1) + '/' + date.getDate();
        if (name !== undefined) {
            return this.getNextAvailable("", datepart + '/' + util.kebabCase(name));
        } else {
            return this.getNextAvailable(1, datepart + '/');
        }
    }
    
    hiddenFilter = e => !e.category.some(c => c === 'hidden');
    mainFilter = e => !e.isReply() && !e.isLike();
    replyFilter = e => e.isReply() || e.isLike();
    articleFilter = e => e.isArticle();
    
    getArticles() {
        var entries = this.getAll().filter(this.articleFilter).filter(this.hiddenFilter);
        entries.sort(mfo.Entry.byDateDesc);
        return entries;
    }

    async generateStreams() {
        var entries = this.getAll();
        entries.sort(mfo.Entry.byDateDesc);
        // main stream
        var limit = this.config.entriesPerPage;
        var chunks = util.chunk(limit, entries.filter(this.mainFilter).filter(this.hiddenFilter));
        await util.map(util.range(0, chunks.length - 1), async (index) => {
            let chunk = chunks[index];
            await this._generateStream(chunk, index + 1, chunks.length);
        });
        // reply stream
        var chunks = util.chunk(limit, entries.filter(this.replyFilter).filter(this.hiddenFilter));
        await util.map(util.range(0, chunks.length - 1), async (index) => {
            let chunk = chunks[index];
            await this._generateReplyStream(chunk, index + 1, chunks.length);
        });
        // tags
        var tags = util.unique(util.flatten(entries.map(e => e.category)));
        await util.map(tags, async (tag) => {
            await this._generateIndex(entries.filter(e => e.category.indexOf(tag) > -1),
            'Posts tagged ' + tag, this.getPathForTag(tag));
        });
        // articles
        await this._generateIndex(entries.filter(e => e.isArticle()), 'Articles', '/articles');
    }
    
    async generateAll() {
        var entries = this.getAll();
        entries.sort(mfo.Entry.byDateDesc);
        // entries
        await util.map(entries, async (entry) => {
            let html = this.renderEntry(entry);
            let path = url.parse(entry.url).pathname;
            await this.publisher.put(path, html, 'text/html');
            debug('Published '+ path);
        });
        await this.generateStreams();
    }

    async validate() {
        var failures: {key: string, expected: mfo.Entry, actual: mfo.Entry}[] = [];
        var keys = await this.publisher.list();
        for (let key of keys) {
            try {
                var u = url.resolve(this.config.url, key);
                var obj = await this.publisher.get(key);
                if (obj.ContentType == 'text/html') {
                    var isEntry = false;
                    try {                       
                        var expected = await mfo.getEntryFromHtml(obj.Body, u);
                        isEntry = true;
                    } catch (e) {}
                    if (isEntry && (expected.url === u || expected.url + '.html' === u)) {
                        let html = this.renderEntry(expected);
                        var actual = await mfo.getEntryFromHtml(html, expected.url);
                        assert.deepEqual(actual, expected);
                        debug('pass ' + expected.url);
                    }
                }
            } catch (err) {
                debug('fail ' + expected.url);
                failures.push({key, expected, actual});
            }
        }
        debug('Validation complete: ' + failures.length + ' failures');
        return failures;
    }

    async sendWebmentionsFor(entry: mfo.Entry) {
        await util.map(entry.getMentions(), async (link) => {
            try {
                await util.sendWebmention(entry.url, link);
                debug('Sent webmention to ' + link);
            } catch (err) {
                debug('Webmention to ' + link + ' failed: ' + err.message);
            }
        });
    }

    async receiveWebmention(sourceUrl: string, targetUrl: string) {
        try {
            var release = await this.mutex.lock();
            try {
                var targetEntry = this.get(targetUrl);
            } catch (err) {
                throw new util.BadRequest('Target ' + targetUrl + ' not found');
            }
            try {
                var sourceEntry = await mfo.getEntry(sourceUrl);
            } catch (err) {
                throw new util.BadRequest('Source ' + sourceUrl + ' not found');
            }
            if (!sourceEntry.getMentions().some(m => m === targetUrl)) {
                throw new util.BadRequest('Link to target ' + targetUrl + ' not found');
            } else {
                targetEntry.addChild(sourceEntry);
                var targetHtml = this.renderEntry(targetEntry);
                await this.publisher.put(url.parse(targetEntry.url).pathname, targetHtml, 'text/html');
                await this.publisher.commit(util.truncate('[' + sourceEntry.author.name + '] ' + util.collapse(sourceEntry.name), 50) +
                '\n' + sourceUrl + ' -> ' + targetUrl);
                debug('Received webmention from ' + sourceUrl);
            }
        } finally {
            release();
        }
    }

}

export = Site;