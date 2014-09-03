#!/usr/local/bin/node

var maxload = 36;

var maxcpulimit = 400;
var maxiolimit = 1000;
var maxiopslimit = 100;

var mincpulimit = 1;
var miniolimit = 1;
var miniopslimit = 1;

var os = require('os');
var child_process = require('child_process');
var exec = child_process.exec;

var loadbefore = 0;
var cycle = 0;

var sorter = function(a,b){return a-b;};

var setbw = function (loadavg) {
    console.log('cycle ' + cycle++ + ' at ' + (new Date()).toString() + ' w/ lavg ' + loadavg);
    exec('/usr/sbin/vzlist -jo ctid,laverage,layout,cpulimit,iolimit,iopslimit -s laverage', {maxBuffer: 1048576}, function (err, stdout, stderr) {
        if (err) {
            console.log('Error while reading vzlist:', err, stderr);
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
        var thiscontainerparams = [];
        
        var key = 0;
        for (key = 0; key < containerlist.length; key++) {
            if (!containerlist[key].laverage) {
                containerlist[key].laverage = [0, 0, 0];
            }
            containerloads.push(containerlist[key].laverage[0], containerlist[key].laverage[1], containerlist[key].laverage[2]);
            containerlist[key].iolimit = containerlist[key].iolimit / 1048576;
        }
        containertopload = containerloads.sort(sorter).slice(containerloads.length - 1, containerloads.length)[0];
        if (!containertopload) {
            containertopload = 1;
        }
        for (key = 0; key < containerlist.length; key++) {
            thiscontainertopload   = containerlist[key].laverage.sort(sorter).slice(2, 3)[0];
            multiplier             = ((maxload - loadavg / containertopload * thiscontainertopload) / maxload);
            if (isNaN(multiplier)) {
                console.log('ERROR: Unexpected behavior: multiplier is NaN:', maxload, loadavg, containertopload, thiscontainertopload, maxload);
                multiplier = 1;
            }
            thiscontainercpulimit  = Math.ceil(Math.round(maxcpulimit * multiplier / 25) * 25);
            thiscontaineriolimit   = Math.ceil(maxiolimit   * multiplier);
            thiscontaineriopslimit = Math.ceil(maxiopslimit * multiplier);
            if (multiplier >= 0.95 || (thiscontainercpulimit >= maxcpulimit && thiscontaineriolimit >= maxiolimit && thiscontaineriopslimit >= maxiopslimit)) {
                thiscontainercpulimit  = 0;
                thiscontaineriolimit   = 0;
                thiscontaineriopslimit = 0;
            } else if (multiplier <= 0 || thiscontainercpulimit < mincpulimit || thiscontaineriolimit < miniolimit || thiscontaineriopslimit < miniopslimit) {
                thiscontainercpulimit  = mincpulimit;
                thiscontaineriolimit   = miniolimit;
                thiscontaineriopslimit = miniopslimit;
            }
            if (containerlist[key].layout !== 'ploop') {
                thiscontaineriopslimit = 0;
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
            if (thiscontainerparams.length) {
                thiscontainerparams = ['/usr/sbin/vzctl', '--skiplock', '--quiet', 'set', containerlist[key].ctid].concat(thiscontainerparams);
                console.log(thiscontainerparams.join(' '), 'loadavg ' + loadavg + ' multiplier ' + multiplier + ' containertopload ' + containertopload + ' thiscontainertopload ' + thiscontainertopload);
                exec(thiscontainerparams.join(' '));
            }
        }
    });
};


var predictload = function () {
    var loadcurrent = os.loadavg()[0];
    var loadafter = loadcurrent + (loadcurrent - loadbefore);
    loadbefore = loadcurrent;
    return loadafter < loadcurrent ? loadcurrent : loadafter;
};

var loop = function () {
    setbw(predictload());
};
setbw(predictload());

setInterval(loop, 5000);