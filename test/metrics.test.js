/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var format = require('util').format;
var restify = require('restify');
var url = require('url');
var vasync = require('vasync');

var common = require('./common');
var config = common.config;

var metricsClient;
var promLabels;
var vmapiClient;

function createMetricsClient() {
    var vmapiUrl = process.env.VMAPI_URL;
    var parsedUrl = url.parse(vmapiUrl);
    parsedUrl.port = 8881;
    parsedUrl.host = null;

    var metricsUrl = url.format(parsedUrl);
    var client = restify.createStringClient({
        connectTimeout: 250,
        rejectUnauthorized: false,
        retry: false,
        url: metricsUrl
    });

    return client;
}

/*
 * The metrics endpoint returns metrics in the Prometheus v0.0.4 format.
 * This function takes the metrics response and a metric to match the metric
 * line you want to match as input and returns the count of that metric.
 */
function getMetricCount(metricsRes, metricsLabels) {
    var labels = promLabels.concat(metricsLabels);
    var metricsLines = metricsRes.split('\n');
    var metricLine = metricsLines.filter(function (line) {
        var match = true;
        labels.forEach(function (label) {
            var lineMatch = line.indexOf(label);
            if (lineMatch === -1) {
                match = false;
            }
        });

        return match;
    });
    var count = parseInt(metricLine[0].split('} ')[1]);
    return count;
}

function fetchMetricCount(metricsLabels, callback) {
    metricsClient.get('/metrics', function getMetrics(err, req, res, data) {
        var count = getMetricCount(data, metricsLabels);
        callback(err, count);
    });
}

function incrementListVmCount(_, callback) {
    var endpoint = '/vms?limit=1';
    vmapiClient.get(endpoint, callback);
}

exports.setUp = function (callback) {
    common.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        vmapiClient = _client;
        metricsClient = createMetricsClient();

        var shortUserAgent = vmapiClient.headers['user-agent'].split(' ')[0];
        promLabels = [
            format('datacenter="%s"', config.datacenterName),
            format('instance="%s"', config.instanceUuid),
            format('route="%s"', 'listvms'),
            format('server="%s"', config.serverUuid),
            format('service="%s"', config.serviceName),
            format('status_code="%d"', 200),
            format('user_agent="%s"', shortUserAgent)
        ];

       callback();
    });
};

exports.metrics_handler = function (t) {
    metricsClient.get('/metrics', function getMetrics(err, req, res, data) {
        common.ifError(t, err);
        t.ok(res, 'The response should exist');
        t.equal(res.statusCode, 200, 'The status code should be 200');
        t.ok(data, 'The data should exist');
        t.done();
    });
};

exports.metrics_counter = function (t) {
    var listVmCount;
    var updatedListVmCount;

    var metricsLabels = [ 'http_requests_completed' ];

    vasync.pipeline({
        funcs: [
            incrementListVmCount,
            function getVmCount(ctx, next) {
                fetchMetricCount(metricsLabels, function (err, count) {
                    common.ifError(t, err);
                    listVmCount = count;
                    next();
                });
            },
            incrementListVmCount,
            function getUpdatedVmCount(ctx, next) {
                fetchMetricCount(metricsLabels, function (err, count) {
                    common.ifError(t, err);
                    updatedListVmCount = count;
                    next();
                });
            }
        ]
    }, function (err, results) {
        common.ifError(t, err);
        t.ok(listVmCount, 'listvm count');
        t.ok(updatedListVmCount, 'updated listvm count');
        t.ok(listVmCount < updatedListVmCount,
                'listvm count should increase');
        t.done();
    });
};

exports.metrics_histogram_counter = function (t) {
    var listVmDurationCount;
    var updatedListVmDurationCount;

    var metricsLabels = [
        format('le="%s"', '+Inf'),
        'http_request_duration_seconds'
    ];

    vasync.pipeline({
        funcs: [
            incrementListVmCount,
            function getListDurationCount(ctx, next) {
                fetchMetricCount(metricsLabels, function (err, count) {
                    common.ifError(t, err);
                    listVmDurationCount = count;
                    next();
                });
            },
            incrementListVmCount,
            function getUpdatedListDurationCount(ctx, next) {
                fetchMetricCount(metricsLabels, function (err, count) {
                    common.ifError(t, err);
                    updatedListVmDurationCount = count;
                    next();
                });
            }
        ]
    }, function (err, results) {
        common.ifError(t, err);
        t.ok(listVmDurationCount, 'listvm duration count');
        t.ok(updatedListVmDurationCount, 'updated listvm duration count');
        t.ok(listVmDurationCount < updatedListVmDurationCount,
                'listvm duration count should increase');
        t.done();
    });
};
