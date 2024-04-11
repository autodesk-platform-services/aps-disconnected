const fetch = require('node-fetch');
const zip = require('node-zip');
const zlib = require('zlib');
const express = require('express');
const { SdkManagerBuilder } = require('@aps_sdk/autodesk-sdkmanager');
const { AuthenticationClient, Scopes } = require('@aps_sdk/authentication');
const { OssClient } = require('@aps_sdk/oss');
const { APS_CLIENT_ID, APS_CLIENT_SECRET, APS_BUCKET} = process.env;

const BaseUrl = 'https://developer.api.autodesk.com';
const sdkManager = SdkManagerBuilder.create().build();
const authenticationClient = new AuthenticationClient(sdkManager);
const ossClient = new OssClient(sdkManager);
let router = express.Router();

let _credentials = null;
async function getAccessToken() {
    if (!_credentials || _credentials.expires_at < Date.now()) {
        _credentials = await authenticationClient.getTwoLeggedToken(APS_CLIENT_ID, APS_CLIENT_SECRET, [Scopes.DataRead, Scopes.ViewablesRead]);
        _credentials.expires_at = Date.now() + _credentials.expires_in * 1000;
    }
    return _credentials.access_token;
}

async function listObjects(bucketKey) {
    const accessToken = await getAccessToken();
    let resp = await ossClient.getObjects(accessToken, bucketKey, { limit: 64 });
    let objects = resp.items;
    while (resp.next) {
        const startAt = new URL(resp.next).searchParams.get('startAt');
        resp = await ossClient.getObjects(accessToken, bucketKey, { startAt, limit: 64 });
        objects = objects.concat(resp.items);
    }
    return objects;
}

// GET /api/models
// Returns a JSON array of objects in our application's bucket ($APS_BUCKET),
// with each item in the array containing properties 'bucketKey', 'objectKey',
// 'objectId', 'sha1', 'size', and 'location'.
router.get('/api/models', async function(req, res, next) {
    try {
        const objects = await listObjects(APS_BUCKET);
        res.json(objects);
    } catch(err) {
        next(err);
    }
});

// GET /api/models/:urn/files
// Returns a JSON list of all derivatives for a given model URN
// and a list of files each derivative depends on.
router.get('/api/models/:urn/files', async function(req, res, next) {
    try {
        const accessToken = await getAccessToken();
        const manifest = await getManifest(req.params.urn, accessToken);
        const items = parseManifest(manifest);
        const derivatives = items.map(async (item) => {
            let files = [];
            switch (item.mime) {
                case 'application/autodesk-svf':
                    files = await getDerivativesSVF(item.urn, accessToken);
                    break;
                case 'application/autodesk-f2d':
                    files = await getDerivativesF2D(item, accessToken);
                    break;
                case 'application/autodesk-db':
                    files = ['objects_attrs.json.gz', 'objects_vals.json.gz', 'objects_offs.json.gz', 'objects_ids.json.gz', 'objects_avs.json.gz', item.rootFileName];
                    break;
                default:
                    files = [item.rootFileName];
                    break;
            }
            return Object.assign({}, item, { files });
        });
        const urls = await Promise.all(derivatives);
        res.json(urls);
    } catch (err) {
        next(err);
    }
});

async function getManifest(urn, token) {
    const res = await fetch(BaseUrl + `/modelderivative/v2/designdata/${urn}/manifest`, {
        compress: true,
        headers: { 'Authorization': 'Bearer ' + token }
    });
    return res.json();
}

function parseManifest(manifest) {
    const items = [];
    function parse(node) {
        const roles = [
            'Autodesk.CloudPlatform.DesignDescription',
            'Autodesk.CloudPlatform.PropertyDatabase',
            'Autodesk.CloudPlatform.IndexableContent',
            'leaflet-zip',
            'thumbnail',
            'graphics',
            'preview',
            'raas',
            'pdf',
            'lod'
        ];
        if (roles.includes(node.role)) {
            const item = {
                guid: node.guid,
                mime: node.mime
            };
            items.push(Object.assign({}, item, getPathInfo(node.urn)));
        }
        if (node.children) {
            node.children.forEach(parse);
        }
    }

    parse({ children: manifest.derivatives });
    return items;
}

function getPathInfo(encodedURN) {
    const urn = decodeURIComponent(encodedURN);
    const rootFileName = urn.slice(urn.lastIndexOf('/') + 1);
    const basePath = urn.slice(0, urn.lastIndexOf('/') + 1);
    const localPath = basePath.slice(basePath.indexOf('/') + 1).replace(/^output\//, '');
    return {
        urn,
        rootFileName,
        localPath,
        basePath
    };
}

async function getDerivative(urn, token) {
    const res = await fetch(BaseUrl + `/derivativeservice/v2/derivatives/${encodeURIComponent(urn)}`, {
        compress: true,
        headers: { 'Authorization': 'Bearer ' + token }
    });
    const buff = await res.buffer();
    return buff;
}

async function getDerivativesSVF(urn, token) {
    const data = await getDerivative(urn, token);
    const pack = new zip(data, { checkCRC32: true, base64: false });
    const manifest = JSON.parse(pack.files['manifest.json'].asText());
    if (!manifest.assets) {
        return [];
    }

    return manifest.assets
        .map(asset => asset.URI)
        .filter(uri => uri.indexOf('embed:/') === -1);
}

async function getDerivativesF2D(item, token) {
    const manifestPath = item.basePath + 'manifest.json.gz';
    const data = await getDerivative(manifestPath, token);
    const manifestData = zlib.gunzipSync(data);
    const manifest = JSON.parse(manifestData.toString('utf8'));
    if (!manifest.assets) {
        return [];
    }

    return manifest.assets
        .map(asset => asset.URI)
        .filter(uri => uri.indexOf('embed:/') === -1)
        .concat(['manifest.json.gz']);
}

module.exports = router;