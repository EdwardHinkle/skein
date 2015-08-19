var fs = require('fs');
var os = require('os');
var path = require('path');
var querystring = require('querystring');
var express = require('express');
var Busboy = require('busboy');
var app = express();
var ejs = require('ejs');
var crypto = require('crypto');
var nodefn = require('when/node');
var util = require('util');
var debug = require('debug')('api');
var microformat = require('./microformat');

if (process.argv[3] === undefined)
    var configFile = 'config.json';
else
    configFile = process.argv[3];
var site = require('./site').init(JSON.parse(fs.readFileSync(configFile)));

app.set('views', './template');
app.set('view engine', 'ejs');

// store the last code issued by the auth endpoint in memory
var lastIssuedCode = null;

function parsePost(req, res, next) {
    if (req.method === 'POST') {
        var busboy = new Busboy({headers: req.headers});
        req.post = {};
        req.files = {};
        busboy.on('field', function (fieldname, val) {
            req.post[fieldname] = val;
        });
        busboy.on('file', function (fieldname, file, filename, encoding, mimetype) {
            var tmpfile = path.join(os.tmpdir(), path.basename(filename));
            req.files[fieldname] = {tmpfile: tmpfile, filename: filename, mimetype: mimetype};
            file.pipe(fs.createWriteStream(tmpfile));
        });
        busboy.on('finish', function () {
            next();
        });
        req.pipe(busboy);
    } else {
        next();
    }
}

function denyAccess(req, res) {
    debug('Access denied');
    res.sendStatus(401);
}

function requireAuth(scope) {
    return function(req, res, next) {
        var token;
        if (req.headers.authorization !== undefined) {
            var re = /^bearer (.+)/i;
            var match = re.exec(req.headers.authorization);
            if (match === null || match[1] === undefined)
                return denyAccess(req, res);
            token = match[1];
        } else if (req.post !== undefined && req.post.access_token !== undefined) {
            token = req.post.access_token;
        } else {
            return denyAccess(req, res);
        }
        site.getToken(token).
            then(function (row) {
                if (row === undefined || !row.scope.split(' ').some(function(s) {return s === scope;}))
                    return denyAccess(req, res);
                next();
            });

    };
}

function rateLimit(count, cooldown) {
    var lastreq = new Date();
    var capacity = count;
    return function(req, res, next) {
        capacity = Math.min(capacity + (new Date() - lastreq) * (count / cooldown), count);
        if (capacity >= 1) {
            capacity--;
            lastreq = new Date();
            next();
        } else {
            res.sendStatus(429);
        }
    };
}

function logger(req, res, next) {
    var parms = (req.method == 'POST' ? req.post : req.query);
    debug('%s %s %s', req.ip, req.method, req.url);
    if (Object.keys(parms).length > 0)
        debug(util.inspect(req.method == 'POST' ? req.post : req.query));
    next();
}

function handleError(res, error) {
    debug(error.stack);
    res.sendStatus(500);
}

app.use(parsePost);
app.use(logger);

app.get('/auth', function(req, res) {
    res.render('authform', req.query);
});

app.post('/auth', rateLimit(3, 1000 * 60 * 10), function(req, res) {
    if (req.post.password === site.config.password) {
        nodefn.call(crypto.randomBytes, 18).
            then(function (buf) {
                var code = buf.toString('base64');
                lastIssuedCode = {
                    code: code,
                    client_id: req.post.client_id,
                    scope: req.post.scope,
                    date: new Date()
                };
                res.redirect(req.post.redirect_uri + '?' +
                querystring.stringify({code: code, state: req.post.state, me: site.config.url}));
            }).
            catch(function (e) {
                handleError(res, e);
            });
    } else {
        debug('Failed password authentication from ' + req.ip);
        res.sendStatus(401);
    }
});

app.post('/token', rateLimit(3, 1000 * 60), function(req, res) {
    if (lastIssuedCode !== null &&
        lastIssuedCode.code === req.post.code &&
        ((new Date() - lastIssuedCode.date) < 60 * 1000)) {
        site.generateToken(lastIssuedCode.client_id, lastIssuedCode.scope).
            then(function (result) {
                lastIssuedCode = null;
                if (result === undefined) {
                    res.sendStatus(500);
                } else {
                    res.type('application/x-www-form-urlencoded');
                    res.send(querystring.stringify({access_token: result.token, scope: result.scope, me: site.config.url}));
                }
            }).
            catch(function (e) {
                handleError(res, e);
            });
    } else {
        debug('Failed token request from ' + req.ip);
        res.sendStatus(401);
    }
});

app.post('/micropub', requireAuth('post'), function(req, res) {
    var entry;
    site.getSlug(req.post.name, true).
        then(function (slug) {
            if (req.post.slug === undefined)
                req.post.slug = slug;
            req.post.url = site.config.url + req.post.slug;
            entry = new microformat.Entry(req.post);
            entry.author = [{
                url: [site.config.url],
                name: [site.config.author.name],
                photo: [site.config.author.photo]
            }];
            return entry;
        }).
        then(function () {
            var key;
            if (req.files.photo !== undefined) {
                return site.getSlug(req.files.photo.filename).
                    then(function (slug) {
                        key = slug;
                        entry.content[0].html = '<p><img class="u-photo" src="' + slug + '" /></p>' +
                        entry.content[0].html;
                        return nodefn.call(fs.readFile, req.files.photo.tmpfile);
                    }).
                    then(function (fstream) {
                        return site.publisher.put(key, fstream, req.files.photo.mimetype);
                    });
            }
        }).
        then(function () {
            return site.publish(entry);
        }).
        then(site.generateIndex).
        then(function() {
            return site.sendWebmentionsFor(entry);
        }).
        then(function () {
            res.location(req.post.slug);
            res.sendStatus(201);
        }).
        catch(function (e) {
            handleError(res, e);
        });
});

app.post('/webmention', rateLimit(50, 1000 * 60 * 60), function(req, res) {
    if (req.post.source === undefined || req.post.target === undefined)
        return res.status(400).send('"source" and "target" parameters are required');
    site.receiveWebmention(req.post.source, req.post.target).
        then(function () {
            res.sendStatus(200);
        }).
        catch(function (e) {
            handleError(res, e);
        });
});

app.get('/tokens', requireAuth('admin'), function(req, res) {
    site.listTokens().
        then(res.json.bind(res)).
        catch(function (e) {
            handleError(res, e);
        });
});

app.delete('/tokens/*', requireAuth('admin'), function(req, res) {
    site.deleteToken(req.params[0]).
        then(res.json.bind(res)).
        catch(function (e) {
            handleError(res, e);
        });
});

var server = app.listen(process.argv[2], function (){
    var address = server.address();
    debug('Listening on %s:%s', address.address, address.port);
});