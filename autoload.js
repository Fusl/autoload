#!/usr/local/bin/node

var ctidwhitelist = [
    810,  // ed-at-rec01.edis.at
    3236, // ed-at-rec02.edis.at
    3279, // fnalerts.sigqu.it - Doesn't need much resources but in case of accidental limitation the daemon unfortunately crashes
    3975, // fvz-rec-at-vie-01 - recursor
    4757  // connection tracker on ed-li-vz01
];

var maxload         = 24;
var maxkill         = 256;
var maxincr         = 12;
var keeploadhistory = 720;

// var maxcpulimit is not required here since we calculate this with the amount of CPU cores set for containers
var maxiolimit   = 1000;
var maxiopslimit = 100;
var maxcpuunits  = 20000;

var mincpulimit  = 1;
var miniolimit   = 1;
var miniopslimit = 1;
var mincpuunits  = 8;

var os   = require('os');
var exec = require('child_process').exec;

var loadbefore = 0;
var cycle = 0;
var killjobs = [];
var killedcontainers = 0;

var sorter = function (a, b) {
    return a - b;
};

var killcontainer = function (ctid) {
    if (killjobs.length) { // Workaround for container mass kill
        console.log('Too many killjobs running, not killing ' + ctid + '!');
        return;
    }
    if (killjobs.indexOf(ctid) !== -1) {
        console.log('Already killing container ' + ctid + '!');
        return;
    }
    killjobs.push(ctid);
    killedcontainers++;
    console.log('Killing container ' + ctid + ' ...');
    exec('/usr/sbin/vzctl --skiplock stop ' + ctid + ' --fast', {maxBuffer: 1048576}, function (err, stdout, stderr) {
        killjobs.splice(killjobs.indexOf(ctid), 1);
        if (err) {
            console.error('Error while killing container ' + ctid + ':', err, stdout, stderr);
            killedcontainers--;
        } else {
            setTimeout(function () {
                killedcontainers--;
            }, 120000);
        }
    });
};

var setbw = function (loadavg) {
    console.log('cycle ' + cycle++ + ' at ' + (new Date()).toString() + ' w/ lavg ' + loadavg);
    exec('/usr/sbin/vzlist -jo ctid,laverage,cpus,layout,cpulimit,iolimit,iopslimit,cpuunits -s laverage', {maxBuffer: 1048576}, function (err, stdout, stderr) {
        if (err) {
            console.error('Error while reading vzlist:', err, stdout, stderr);
            return;
        }
        var containerlist = JSON.parse(stdout).reverse();
        var containerloads = [];
        var containertopload = 0;
        var multiplier = 0;
        
        var thiscontainertopload = 0;
        var thiscontainercpulimit = 0;
        var thiscontaineriolimit = 0;
        var thiscontaineriopslimit = 0;
        var thiscontainercpuunits = 0;
        var thiscontainerparams = [];
        
        var key = 0;
        for (key = 0; key < containerlist.length; key++) {
            if (!containerlist[key].laverage) {
                containerlist[key].laverage = [0, 0, 0];
            }
            containerloads.push(containerlist[key].laverage[0], containerlist[key].laverage[1], containerlist[key].laverage[2]);
            containerlist[key].iolimit = containerlist[key].iolimit / 1048576;
            containerlist[key].maxcpulimit = (!containerlist[key].cpus || containerlist[key].cpus > os.cpus().length ? os.cpus().length : containerlist[key].cpus) * 100;
        }
        containertopload = containerloads.sort(sorter).slice(containerloads.length - 1, containerloads.length)[0];
        if (!containertopload) {
            containertopload = 1;
        }
        for (key = 0; key < containerlist.length; key++) {
            thiscontainertopload   = containerlist[key].laverage.sort(sorter).slice(2, 3)[0];
            multiplier             = ((maxload - loadavg / containertopload * thiscontainertopload) / maxload);
            if (isNaN(multiplier)) {
                console.error('ERROR: Unexpected behavior: multiplier is NaN:', maxload, loadavg, containertopload, thiscontainertopload, maxload);
                multiplier = 1;
            }
            thiscontainercpulimit  = Math.ceil(Math.round(containerlist[key].maxcpulimit * multiplier / 10) * 10);
            thiscontaineriolimit   = Math.ceil(maxiolimit   * multiplier);
            thiscontaineriopslimit = Math.ceil(maxiopslimit * multiplier);
            thiscontainercpuunits  = Math.ceil(Math.round(maxcpuunits  * multiplier / 1000) * 1000);
            if (
                ctidwhitelist.indexOf(containerlist[key].ctid) !== -1 || // If the container is in the whitelist ...
                multiplier >= 0.95 || // ... or the multiplier is above 95% ...
                (thiscontainercpulimit >= containerlist[key].maxcpulimit && thiscontaineriolimit >= maxiolimit && thiscontaineriopslimit >= maxiopslimit && thiscontainercpuunits >= maxcpuunits) || // ... or all specified limitating factors are above the high watermark ...
                containerlist[key].uptime < 60 // ... or the container is running less than 60 seconds ...
               ) {
                // ... don't limit its resources
                thiscontainercpulimit  = 0;
                thiscontaineriolimit   = 0;
                thiscontaineriopslimit = 0;
                thiscontainercpuunits  = maxcpuunits;
            } else if (multiplier <= 0 || thiscontainercpulimit < mincpulimit || thiscontaineriolimit < miniolimit || thiscontaineriopslimit < miniopslimit || thiscontainercpuunits < mincpuunits) {
                // If the given multiplier or the limits are below the low watermark, set the low watermarks as limits
                thiscontainercpulimit  = mincpulimit;
                thiscontaineriolimit   = miniolimit;
                thiscontaineriopslimit = miniopslimit;
                thiscontainercpuunits  = mincpuunits;
            }
            if (containerlist[key].layout !== 'ploop') {
                thiscontaineriopslimit = 0; // iopslimit on simfs containers is horrible (it uses too much CPU cycles)
            }
            thiscontainerparams = [];
            if (containerlist[key].cpulimit !== thiscontainercpulimit) { //if ((containerlist[key].cpulimit === 0 && thiscontainercpulimit !== 0) || (containerlist[key].cpulimit !== 0 && thiscontainercpulimit === 0) || containerlist[key].cpulimit > thiscontainercpulimit || containerlist[key].cpulimit + 5 < thiscontainercpulimit) {
                thiscontainerparams.push('--cpulimit', thiscontainercpulimit);
            }
            if (containerlist[key].iolimit !== thiscontaineriolimit) {
                thiscontainerparams.push('--iolimit', thiscontaineriolimit + 'M');
            }
            if (containerlist[key].iopslimit !== thiscontaineriopslimit) {
                thiscontainerparams.push('--iopslimit', thiscontaineriopslimit);
            }
            if (containerlist[key].cpuunits !== thiscontainercpuunits) {
                thiscontainerparams.push('--cpuunits', thiscontainercpuunits);
            }
            if (loadavg >= maxkill + maxincr * killedcontainers && (thiscontainercpulimit || thiscontaineriolimit || thiscontaineriopslimit || thiscontainercpuunits)) {
                killcontainer(containerlist[key].ctid);
            }
            if (thiscontainerparams.length) {
                thiscontainerparams = ['/usr/sbin/vzctl', '--skiplock', '--quiet', 'set', containerlist[key].ctid].concat(thiscontainerparams);
                console.log(thiscontainerparams.join(' '), 'loadavg ' + loadavg + ' multiplier ' + multiplier + ' containertopload ' + containertopload + ' thiscontainertopload ' + thiscontainertopload);
                exec(thiscontainerparams.join(' '));
            }
        }
    });
};

var predictload = function () {
    var loads = os.loadavg();
    loads.push(loads[0] + (loads[0] - loadbefore), loadbefore);
    loadbefore = loads[0];
    return loads.sort(sorter).slice(4, 5);
};

var loop = function () {
    setbw(predictload());
};

setbw(predictload());

setInterval(loop, 5000);