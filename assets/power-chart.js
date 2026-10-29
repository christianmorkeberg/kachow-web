// Electricity price bars, shared by the chat card (app.js) and the kiosk page (kiosk.js).
// One bar per hour = the all-in price (spot + tariffs + tax + VAT) in kr/kWh, coloured cheap / middle / dear by thirds of the range,
// a marker on the current hour and a band over the cheapest window. card = the `power_prices` render payload of get_power_prices.
window.PowerChart = (function () {
    'use strict';
    function lang() { return (navigator.language || '').toLowerCase().indexOf('da') === 0 ? 'da-DK' : 'en-GB'; }
    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
    }

    function fmt(v) { return (Math.round(v * 100) / 100).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

    function hm(iso) { return String(iso || '').slice(11, 16); }

    function day(iso) {
        var d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
        return isNaN(d) ? '' : d.toLocaleDateString(lang(), { weekday: 'short', day: 'numeric', month: 'short' });
    }

    function svg(card, dims) {
        var hs = card.hours || [], n = hs.length || 1;
        var W = dims[0], H = dims[1], padL = 6, padR = 6, padT = 14, padB = 20;
        var innerW = W - padL - padR, innerH = H - padT - padB, step = innerW / n;
        var vals = hs.map(function (h) { return +h.t || 0; });
        var maxV = Math.max.apply(null, vals.concat([0.01])), lo = Math.min.apply(null, vals), hi = maxV;
        function y(v) { return padT + (maxV - v) / maxV * innerH; }
        function tone(v) { var f = hi === lo ? 0 : (v - lo) / (hi - lo); return f < 0.34 ? 'cheap' : (f < 0.67 ? 'mid' : 'dear'); }

        var out = '<line class="wch-grid" x1="' + padL + '" y1="' + padT + '" x2="' + (W - padR) + '" y2="' + padT + '"/>'
            + '<text class="wch-ylab" x="' + padL + '" y="' + (padT - 3) + '">' + esc(fmt(maxV)) + '</text>'
            + '<line class="wch-grid base" x1="' + padL + '" y1="' + (padT + innerH) + '" x2="' + (W - padR) + '" y2="' + (padT + innerH) + '"/>';
        var w = card.window;
        if (w && w.len > 0) {
            out += '<rect class="pw-window" x="' + (padL + step * w.from).toFixed(1) + '" y="' + (padT - 2) + '" width="' + (step * w.len).toFixed(1)
                + '" height="' + (innerH + 2) + '" rx="3"/>';
        }
        var barW = Math.max(step - (n > 30 ? 1 : 2), 1);
        hs.forEach(function (h, i) {
            var v = +h.t || 0, top = y(v);
            out += '<rect class="chart-bar pw-bar ' + tone(v) + (i === card.now_index ? ' now' : '') + '" data-idx="' + i + '" x="' + (padL + step * i + (step - barW) / 2).toFixed(1)
                + '" y="' + top.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + Math.max(padT + innerH - top, 1).toFixed(1) + '" rx="1.5"/>';
        });
        var every = n > 30 ? 6 : (n > 14 ? 3 : 2);
        hs.forEach(function (h, i) {
            var hr = String(h.s).slice(11, 13);
            if (i % every === 0 || hr === '00') {
                out += '<text class="wch-xlab" x="' + (padL + step * i + step / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">'
                    + (hr === '00' ? esc(day(h.s).split(' ')[0]) : esc(hr)) + '</text>';
            }
            out += '<rect class="wch-hit" data-idx="' + i + '" x="' + (padL + step * i).toFixed(1) + '" y="' + padT + '" width="' + step.toFixed(1) + '" height="' + innerH + '"/>';
        });
        if (card.now_index != null) {
            var nx = padL + step * card.now_index + step / 2;
            out += '<line class="pw-now" x1="' + nx.toFixed(1) + '" y1="' + (padT - 2) + '" x2="' + nx.toFixed(1) + '" y2="' + (padT + innerH) + '"/>';
        }
        return '<svg class="wch-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(card.title || 'Electricity price') + '">' + out + '</svg>';
    }

    return { fmt: fmt, hm: hm, day: day, svg: svg };
})();
