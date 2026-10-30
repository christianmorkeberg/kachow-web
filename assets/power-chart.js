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

    /** A "nice" tick step (0.1 … 10 kr) giving about five gridlines up to maxV. */
    function niceStep(maxV) {
        var raw = maxV / 5, steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20];
        for (var i = 0; i < steps.length; i++) if (steps[i] >= raw) return steps[i];
        return 50;
    }
    function tickLabel(v, step) {
        return step >= 1 ? String(Math.round(v)) : v.toLocaleString('da-DK', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
    }

    /**
     * dims = [width, height] in px (the viewBox, drawn 1:1); fontPx = the size of the axis labels (default 9) — the margins grow with it so
     * the y-axis values always fit. The y axis runs from 0 to the next "nice" value above the highest price, with a labelled gridline at each step.
     */
    function svg(card, dims, fontPx, opts) {
        opts = opts || {};
        var hs = card.hours || [], n = hs.length || 1;
        var fp = fontPx || 9;
        var W = dims[0], H = dims[1], padL = Math.round(fp * 2.7) + 4, padR = 6, padT = Math.round(fp * (opts.nowLabel ? 2.9 : 1.3)), padB = Math.round(fp * 2.1);
        var innerW = W - padL - padR, innerH = H - padT - padB, step = innerW / n;
        var vals = hs.map(function (h) { return +h.t || 0; });
        var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals.concat([0.01]));
        var tickStep = niceStep(hi), maxV = Math.ceil(hi / tickStep - 1e-9) * tickStep;
        function y(v) { return padT + (maxV - v) / maxV * innerH; }
        function tone(v) { var f = hi === lo ? 0 : (v - lo) / (hi - lo); return f < 0.34 ? 'cheap' : (f < 0.67 ? 'mid' : 'dear'); }

        var out = '';
        for (var tv = 0; tv <= maxV + 1e-9; tv += tickStep) {
            var ty = y(tv).toFixed(1);
            out += '<line class="wch-grid' + (tv === 0 ? ' base' : '') + '" x1="' + padL + '" y1="' + ty + '" x2="' + (W - padR) + '" y2="' + ty + '"/>'
                + '<text class="wch-ylab" x="' + (padL - 4) + '" y="' + (+ty + fp * 0.35).toFixed(1) + '" text-anchor="end">' + esc(tickLabel(tv, tickStep)) + '</text>';
        }
        if (opts.nowLabel && card.now_index != null && card.now_index >= 0) {   // a soft band behind the current hour
            out += '<rect class="pw-nowband" x="' + (padL + step * card.now_index).toFixed(1) + '" y="' + (padT - 2) + '" width="' + step.toFixed(1) + '" height="' + (innerH + 2) + '"/>';
        }
        var w = card.window;
        if (w && w.len > 0 && opts.nowLabel) {
            // Kiosk: the cheapest stretch is a thin strip right under its bars (on the axis), so the bars and the gaps between them stay untouched.
            var bh = Math.max(3, fp * 0.28);
            out += '<rect class="pw-window" x="' + (padL + step * w.from + 1).toFixed(1) + '" y="' + (padT + innerH + 3).toFixed(1) + '" width="' + (step * w.len - 2).toFixed(1) + '" height="' + bh.toFixed(1) + '"/>';
        } else if (w && w.len > 0) {
            out += '<rect class="pw-window" x="' + (padL + step * w.from).toFixed(1) + '" y="' + (padT - 2) + '" width="' + (step * w.len).toFixed(1)
                + '" height="' + (innerH + 2) + '" rx="3"/>';
        }
        var barW = Math.max(step - (n > 30 ? 1 : 2), 1);
        hs.forEach(function (h, i) {
            var v = +h.t || 0, top = y(v);
            out += '<rect class="chart-bar pw-bar ' + tone(v) + (i === card.now_index ? ' now' : (card.now_index != null && i < card.now_index ? ' past' : '')) + '" data-idx="' + i + '" x="' + (padL + step * i + (step - barW) / 2).toFixed(1)
                + '" y="' + top.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + Math.max(padT + innerH - top, 1).toFixed(1) + '" rx="1.5"/>';
        });
        var every = n > 30 ? 6 : (n > 14 ? 3 : 2);
        hs.forEach(function (h, i) {
            var hr = String(h.s).slice(11, 13);
            if (hr === '00' && i > 0) {   // a thin line where a new day starts
                out += '<line class="pw-day" x1="' + (padL + step * i).toFixed(1) + '" y1="' + padT + '" x2="' + (padL + step * i).toFixed(1) + '" y2="' + (padT + innerH) + '"/>';
            }
            // Long ranges are labelled on the clock (00, 06, 12, 18) so the day boundaries line up with the labels.
            if (n > 30 ? (parseInt(hr, 10) % 6 === 0) : (i % every === 0 || hr === '00')) {
                out += '<text class="wch-xlab" x="' + (padL + step * i + step / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">'
                    + (hr === '00' ? esc(day(h.s).split(' ')[0]) : esc(hr)) + '</text>';
            }
            out += '<rect class="wch-hit" data-idx="' + i + '" x="' + (padL + step * i).toFixed(1) + '" y="' + padT + '" width="' + step.toFixed(1) + '" height="' + innerH + '"/>';
        });
        if (opts.nowLabel && card.now_index != null && card.now_index >= 0) {
            // "● now" tag above the current hour, with a small pointer down to its bar
            var cx = padL + step * card.now_index + step / 2, lab = String(opts.nowLabel), tw = lab.length * fp * 0.62 + fp * 1.6, th = fp * 1.55;
            var tx = Math.max(padL, Math.min(W - padR - tw, cx - tw / 2)), ty = 1;
            out += '<g class="pw-nowtag"><rect class="pw-nowtag-bg" x="' + tx.toFixed(1) + '" y="' + ty + '" width="' + tw.toFixed(1) + '" height="' + th.toFixed(1) + '"/>'
                + '<circle class="pw-nowtag-dot" cx="' + (tx + fp * 0.7).toFixed(1) + '" cy="' + (ty + th / 2).toFixed(1) + '" r="' + (fp * 0.2).toFixed(1) + '"/>'
                + '<text class="pw-nowtag-txt" x="' + (tx + fp * 1.15).toFixed(1) + '" y="' + (ty + th / 2 + fp * 0.35).toFixed(1) + '">' + esc(lab) + '</text>'
                + '<path class="pw-nowtag-tip" d="M' + (cx - fp * 0.4).toFixed(1) + ' ' + (ty + th).toFixed(1) + 'L' + (cx + fp * 0.4).toFixed(1) + ' ' + (ty + th).toFixed(1)
                + 'L' + cx.toFixed(1) + ' ' + (ty + th + fp * 0.5).toFixed(1) + 'Z"/></g>';
        } else if (card.now_index != null) {
            var nx = padL + step * card.now_index + step / 2;
            out += '<line class="pw-now" x1="' + nx.toFixed(1) + '" y1="' + (padT - 2) + '" x2="' + nx.toFixed(1) + '" y2="' + (padT + innerH) + '"/>';
        }
        return '<svg class="wch-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(card.title || 'Electricity price') + '">' + out + '</svg>';
    }

    return { fmt: fmt, hm: hm, day: day, svg: svg };
})();
