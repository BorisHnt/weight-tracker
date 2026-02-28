const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSjT2SSS6qwBRkxbPD73BjDecvjJACuHFoHKrRXssEgOrHmvj5O9b_5NBDYarw3AMKFPKvYYiHfezfH/pub?gid=0&single=true&output=csv";
const POIDS_OBJECTIF = 70;
const NB_DECIMALES = 1;

const COLORS = {
  text: "#FBFBFB",
  muted: "rgba(251, 251, 251, 0.58)",
  border: "#333333",
  raw: "#DD105E",
  ma7: "#FFD700",
  ma28: "#0C3C78",
  gain: "#DD105E",
  loss: "#FFD700",
  neutral: "#5A5A5A",
  axis: "rgba(251, 251, 251, 0.10)",
  grid: "rgba(251, 251, 251, 0.08)"
};

const DAY_MS = 24 * 60 * 60 * 1000;
const CHART_RANGES = {
  "7d": 7,
  "28d": 28,
  "6m": 183,
  "1y": 365,
  all: null
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const statusText = document.getElementById("statusText");

  if (!CSV_URL) {
    setError("Configure CSV_URL en haut de app.js.");
    return;
  }

  try {
    const csvText = await fetchCSV(CSV_URL);
    const records = parseCSV(csvText);

    if (!records.length) {
      throw new Error("Aucune donnee exploitable.");
    }

    const series = buildContinuousSeries(records);
    const ma7 = computeMovingAverage(series, 7);
    const ma28 = computeMovingAverage(series, 28);
    const enrichedSeries = series.map((entry, index) => ({
      ...entry,
      ma7: ma7[index],
      ma28: ma28[index],
      diff: computeDailyDiff(series, index)
    }));

    const weeklyLoss = computeWeeklyLoss(enrichedSeries);
    const rolling28 = compute28DayLoss(enrichedSeries);
    const regressionPoints = enrichedSeries
      .map((entry, index) => (Number.isFinite(entry.ma7) ? { x: index, y: entry.ma7, date: entry.date } : null))
      .filter(Boolean);
    const regression = linearRegression(regressionPoints);
    const goalEstimate = estimateGoalDate(enrichedSeries, regression, POIDS_OBJECTIF);

    const latestEntry = getLatestValueEntry(enrichedSeries);
    const firstEntry = getFirstValueEntry(enrichedSeries);
    const totalLoss = firstEntry && latestEntry ? firstEntry.weight - latestEntry.weight : null;
    const daysSpan = firstEntry && latestEntry ? Math.max(1, differenceInDays(latestEntry.date, firstEntry.date)) : null;
    const averageWeeklyRate = totalLoss !== null && daysSpan ? (totalLoss / daysSpan) * 7 : null;

    renderStats({
      latestEntry,
      totalLoss,
      averageWeeklyRate,
      goalEstimate
    });

    renderPrimaryChart(enrichedSeries);
    setupBarsChartControls(enrichedSeries, weeklyLoss, rolling28);
    renderProjection(enrichedSeries, regression, goalEstimate);
    renderHeatmap(enrichedSeries);

    statusText.textContent = `${records.length} mesures chargees du ${formatDate(firstEntry?.date)} au ${formatDate(latestEntry?.date)}.`;
  } catch (error) {
    setError(error.message || "Impossible de charger le CSV.");
  }
}

async function fetchCSV(url) {
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`Erreur de chargement CSV (${response.status}).`);
  }

  return response.text();
}

function parseCSV(csvText) {
  const lines = csvText
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const entries = new Map();

  for (let index = 1; index < lines.length; index += 1) {
    const [dateRaw = "", weightRaw = ""] = lines[index].split(",").map((value) => value.trim());

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
      continue;
    }

    const date = createUTCDate(dateRaw);
    const weight = Number.parseFloat(weightRaw.replace(",", "."));

    if (Number.isNaN(date.getTime()) || Number.isNaN(weight)) {
      continue;
    }

    entries.set(dateRaw, {
      date,
      isoDate: dateRaw,
      weight
    });
  }

  return Array.from(entries.values()).sort((a, b) => a.date - b.date);
}

function computeMovingAverage(series, windowSize) {
  return series.map((entry, index) => {
    if (!Number.isFinite(entry.weight)) {
      return null;
    }

    let sum = 0;
    let count = 0;
    const start = Math.max(0, index - windowSize + 1);

    for (let cursor = start; cursor <= index; cursor += 1) {
      const weight = series[cursor].weight;

      if (Number.isFinite(weight)) {
        sum += weight;
        count += 1;
      }
    }

    return count ? sum / count : null;
  });
}

function computeWeeklyLoss(series) {
  const buckets = new Map();

  series.forEach((entry) => {
    if (!Number.isFinite(entry.weight)) {
      return;
    }

    const key = getISOWeekKey(entry.date);
    const bucket = buckets.get(key);

    if (!bucket) {
      buckets.set(key, {
        label: key,
        startWeight: entry.weight,
        endWeight: entry.weight,
        endDate: entry.date
      });
      return;
    }

    bucket.endWeight = entry.weight;
    bucket.endDate = entry.date;
  });

  return Array.from(buckets.values()).map((bucket) => ({
    label: bucket.label,
    shortLabel: bucket.label.slice(2),
    value: sanitizeNumber(bucket.startWeight - bucket.endWeight),
    date: bucket.endDate,
    color: bucket.startWeight - bucket.endWeight >= 0 ? COLORS.loss : COLORS.gain
  }));
}

function compute28DayLoss(series) {
  const values = [];

  series.forEach((entry, index) => {
    if (!Number.isFinite(entry.weight)) {
      return;
    }

    let referenceWeight = null;
    let referenceDate = null;
    const threshold = addDays(entry.date, -27).getTime();

    for (let cursor = index; cursor >= 0; cursor -= 1) {
      const candidate = series[cursor];

      if (candidate.date.getTime() < threshold) {
        break;
      }

      if (Number.isFinite(candidate.weight)) {
        referenceWeight = candidate.weight;
        referenceDate = candidate.date;
      }
    }

    if (referenceWeight === null || !referenceDate || differenceInDays(entry.date, referenceDate) < 27) {
      return;
    }

    const value = sanitizeNumber(referenceWeight - entry.weight);
    values.push({
      label: entry.isoDate,
      shortLabel: formatShortDate(entry.date),
      value,
      date: entry.date,
      color: value >= 0 ? COLORS.loss : COLORS.gain
    });
  });

  return values;
}

function linearRegression(points) {
  if (!points.length) {
    return { slope: null, intercept: null, r2: null };
  }

  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  let sumYY = 0;

  points.forEach((point) => {
    sumX += point.x;
    sumY += point.y;
    sumXY += point.x * point.y;
    sumXX += point.x * point.x;
    sumYY += point.y * point.y;
  });

  const denominator = n * sumXX - sumX * sumX;
  const slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  const correlationDenominator = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));
  const r = correlationDenominator === 0 ? 0 : (n * sumXY - sumX * sumY) / correlationDenominator;

  return {
    slope: sanitizeNumber(slope),
    intercept: sanitizeNumber(intercept),
    r2: sanitizeNumber(r * r)
  };
}

function estimateGoalDate(series, regression, targetWeight) {
  const latestEntry = getLatestValueEntry(series);
  const latestTrendEntry = [...series].reverse().find((entry) => Number.isFinite(entry.ma7));
  const currentWeight = latestTrendEntry?.ma7 ?? latestEntry?.weight ?? null;

  if (!latestEntry || currentWeight === null || !Number.isFinite(regression.slope)) {
    return {
      estimatedDate: null,
      daysRemaining: null,
      currentWeight,
      slopePerDay: regression.slope
    };
  }

  if (currentWeight <= targetWeight) {
    return {
      estimatedDate: latestEntry.date,
      daysRemaining: 0,
      currentWeight,
      slopePerDay: regression.slope
    };
  }

  if (regression.slope >= 0) {
    return {
      estimatedDate: null,
      daysRemaining: null,
      currentWeight,
      slopePerDay: regression.slope
    };
  }

  const rawDays = (targetWeight - currentWeight) / regression.slope;
  const daysRemaining = Number.isFinite(rawDays) ? Math.max(0, Math.ceil(rawDays)) : null;

  return {
    estimatedDate: daysRemaining === null ? null : addDays(latestEntry.date, daysRemaining),
    daysRemaining,
    currentWeight,
    slopePerDay: regression.slope
  };
}

function renderStats({ latestEntry, totalLoss, averageWeeklyRate, goalEstimate }) {
  const statsGrid = document.getElementById("statsGrid");
  const cards = Array.from(statsGrid.querySelectorAll(".stat-card"));

  if (cards.length < 4) {
    return;
  }

  cards[0].querySelector(".stat-value").textContent = latestEntry ? `${formatWeight(latestEntry.weight)} kg` : "--";
  cards[0].querySelector(".stat-meta").textContent = latestEntry ? formatDate(latestEntry.date) : "Aucune mesure";

  cards[1].querySelector(".stat-value").textContent = totalLoss === null ? "--" : `${formatSignedWeight(totalLoss)} kg`;
  cards[1].querySelector(".stat-meta").textContent = totalLoss === null ? "Donnees insuffisantes" : totalLoss >= 0 ? "Perte cumulee" : "Evolution cumulee";

  cards[2].querySelector(".stat-value").textContent = averageWeeklyRate === null ? "--" : `${formatSignedWeight(averageWeeklyRate)} kg`;
  cards[2].querySelector(".stat-meta").textContent = averageWeeklyRate === null ? "Donnees insuffisantes" : "Moyenne sur la periode";

  const goalValue = cards[3].querySelector(".stat-value");
  const goalMeta = cards[3].querySelector(".stat-meta");

  if (goalEstimate.estimatedDate) {
    goalValue.textContent = formatDate(goalEstimate.estimatedDate);
    goalMeta.textContent = goalEstimate.daysRemaining === 0 ? "Objectif atteint" : `${goalEstimate.daysRemaining} jours restants`;
  } else if (goalEstimate.currentWeight !== null) {
    goalValue.textContent = "Non estime";
    goalMeta.textContent = "Tendance insuffisante ou orientee a la hausse";
  } else {
    goalValue.textContent = "--";
    goalMeta.textContent = "Donnees insuffisantes";
  }
}

function drawLineChart(canvas, datasets, options = {}) {
  canvas.__chartType = "line";
  canvas.__chartData = { datasets, options };
  setupCanvasRedraw(canvas);
  renderCanvasChart(canvas);
}

function drawBarChart(canvas, data, options = {}) {
  canvas.__chartType = "bar";
  canvas.__chartData = { data, options };
  setupCanvasRedraw(canvas);
  renderCanvasChart(canvas);
}

function drawCandlestickChart(canvas, data, options = {}) {
  canvas.__chartType = "candles";
  canvas.__chartData = { data, options };
  setupCanvasRedraw(canvas);
  renderCanvasChart(canvas);
}

function renderHeatmap(series) {
  const grid = document.getElementById("heatmapGrid");
  const monthRow = document.getElementById("heatmapMonths");
  const yAxis = document.getElementById("heatmapYAxis");
  const legend = document.getElementById("heatmapLegend");
  const tooltip = document.getElementById("tooltip");
  const firstEntry = series[0];

  grid.innerHTML = "";
  monthRow.innerHTML = "";
  yAxis.innerHTML = "";
  legend.innerHTML = "";

  if (!firstEntry) {
    return;
  }

  ["", "L", "M", "M", "J", "V", "S", "D"].forEach((label) => {
    const item = document.createElement("span");
    item.textContent = label;
    yAxis.appendChild(item);
  });

  const maxDiff = series.reduce((accumulator, entry) => {
    const value = Math.abs(entry.diff ?? 0);
    return value > accumulator ? value : accumulator;
  }, 0);

  const entryMap = new Map(series.map((entry) => [entry.isoDate, entry]));
  const gridStart = startOfISOWeek(firstEntry.date);
  const gridEnd = endOfISOWeek(series[series.length - 1].date);
  const totalDays = differenceInDays(gridEnd, gridStart) + 1;
  const weekCount = Math.ceil(totalDays / 7);
  let previousMonthKey = "";

  for (let weekIndex = 0; weekIndex < weekCount; weekIndex += 1) {
    const weekStart = addDays(gridStart, weekIndex * 7);
    const monthCell = document.createElement("div");
    monthCell.className = "heatmap-month";
    const monthLabel = getHeatmapMonthLabel(weekStart, previousMonthKey, firstEntry.date);

    if (monthLabel.text) {
      const text = document.createElement("span");
      text.textContent = monthLabel.text;
      monthCell.appendChild(text);
      previousMonthKey = monthLabel.key;
    }

    monthRow.appendChild(monthCell);
  }

  for (let dayIndex = 0; dayIndex < totalDays; dayIndex += 1) {
    const date = addDays(gridStart, dayIndex);
    const isoDate = formatISODate(date);
    const entry = entryMap.get(isoDate) || {
      date,
      isoDate,
      weight: null,
      diff: null
    };
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "heatmap-cell";
    const fill = document.createElement("span");
    fill.className = "heatmap-fill";

    if (!Number.isFinite(entry.weight)) {
      cell.classList.add("is-missing");
    } else if (!Number.isFinite(entry.diff) || entry.diff === 0) {
      cell.classList.add("is-flat");
    } else if (entry.diff < 0) {
      cell.classList.add("is-loss");
    } else {
      cell.classList.add("is-gain");
    }

    const opacity = maxDiff > 0 && Number.isFinite(entry.diff)
      ? Math.min(0.92, Math.max(0.16, Math.abs(entry.diff) / maxDiff))
      : 0.18;
    cell.style.setProperty("--cell-opacity", opacity.toFixed(2));
    cell.dataset.tooltip = buildHeatmapTooltip(entry);
    cell.setAttribute("aria-label", cell.dataset.tooltip.replace(/\n/g, ", "));
    cell.appendChild(fill);

    cell.addEventListener("mouseenter", showTooltip);
    cell.addEventListener("mousemove", moveTooltip);
    cell.addEventListener("mouseleave", hideTooltip);
    cell.addEventListener("focus", showTooltip);
    cell.addEventListener("blur", hideTooltip);

    grid.appendChild(cell);
  }

  renderHeatmapLegend(legend);

  function showTooltip(event) {
    const content = event.currentTarget.dataset.tooltip;
    if (!content) {
      return;
    }

    tooltip.textContent = content;
    tooltip.hidden = false;
    moveTooltip(event);
  }

  function moveTooltip(event) {
    const x = event.clientX ?? event.currentTarget.getBoundingClientRect().left + 12;
    const y = event.clientY ?? event.currentTarget.getBoundingClientRect().top + 12;
    const left = Math.min(window.innerWidth - tooltip.offsetWidth - 12, x + 12);
    const top = Math.min(window.innerHeight - tooltip.offsetHeight - 12, y + 12);
    tooltip.style.left = `${Math.max(12, left)}px`;
    tooltip.style.top = `${Math.max(12, top)}px`;
  }

  function hideTooltip() {
    tooltip.hidden = true;
  }
}

function renderHeatmapLegend(container) {
  const lossLabel = document.createElement("span");
  lossLabel.textContent = "Perte";
  container.appendChild(lossLabel);

  [0.2, 0.45, 0.75].forEach((opacity) => {
    const swatch = document.createElement("span");
    const fill = document.createElement("span");
    swatch.className = "heatmap-legend-swatch";
    fill.style.opacity = opacity.toFixed(2);
    swatch.appendChild(fill);
    container.appendChild(swatch);
  });

  const gainLabel = document.createElement("span");
  gainLabel.textContent = "Prise";
  container.appendChild(gainLabel);

  [0.2, 0.45, 0.75].forEach((opacity) => {
    const swatch = document.createElement("span");
    const fill = document.createElement("span");
    swatch.className = "heatmap-legend-swatch is-gain";
    fill.style.opacity = opacity.toFixed(2);
    swatch.appendChild(fill);
    container.appendChild(swatch);
  });
}

function renderPrimaryChart(series) {
  const canvas = document.getElementById("lineChart");
  const datasets = [
    {
      label: "Poids brut",
      values: series.map((entry) => entry.weight),
      color: COLORS.raw,
      lineWidth: 2,
      smooth: false,
      showPoints: true,
      pointRadius: 2.8,
      connectGaps: true
    },
    {
      label: "MA7",
      values: series.map((entry) => entry.ma7),
      color: COLORS.ma7,
      lineWidth: 2.4,
      smooth: true,
      connectGaps: true
    },
    {
      label: "MA28",
      values: series.map((entry) => entry.ma28),
      color: COLORS.ma28,
      lineWidth: 2.4,
      smooth: true,
      connectGaps: true
    }
  ];

  drawLineChart(canvas, datasets, {
    labels: series.map((entry) => entry.isoDate),
    yFormatter: (value) => `${formatWeight(value)} kg`,
    xTickFormatter: (label, index, labels) => filterLineAxisLabel(label, index, labels),
    minHeight: 280
  });
}

function setupBarsChartControls(series, weeklyLoss, rolling28) {
  const metricSelect = document.getElementById("barsMetricSelect");
  const displaySelect = document.getElementById("barsDisplaySelect");
  const rangeSelect = document.getElementById("barsRangeSelect");

  const update = () => {
    renderBarsChart(series, weeklyLoss, rolling28, metricSelect.value, rangeSelect.value, displaySelect.value);
  };

  metricSelect.addEventListener("change", update);
  displaySelect.addEventListener("change", update);
  rangeSelect.addEventListener("change", update);
  update();
}

function renderBarsChart(series, weeklyLoss, rolling28, metricKey = "daily", rangeKey = "7d", displayKey = "bars") {
  const canvas = document.getElementById("barsChart");
  const hint = document.getElementById("barsChartHint");
  const latestEntry = getLatestValueEntry(series);
  const windowDays = CHART_RANGES[rangeKey] ?? null;
  const cutoff = latestEntry && windowDays ? addDays(latestEntry.date, -(windowDays - 1)) : null;
  const metricLabel = getBarsMetricLabel(metricKey);
  const rangeLabel = getBarsRangeLabel(rangeKey);
  const entries = buildBarsChartEntries(series, weeklyLoss, rolling28, metricKey, cutoff);

  hint.textContent = `${metricLabel} sur ${rangeLabel.toLowerCase()} en mode ${displayKey === "market" ? "cours" : "barres"}.`;

  if (displayKey === "market") {
    renderMarketChart(canvas, entries, metricKey);
    return;
  }

  drawBarChart(canvas, entries, {
    yFormatter: (value) => `${formatSignedWeight(value)} kg`,
    xTickFormatter: (item, index, items) => filterBarAxisLabel(item.shortLabel || item.label, index, items.length),
    minHeight: 220
  });
}

function buildBarsChartEntries(series, weeklyLoss, rolling28, metricKey, cutoff) {
  if (metricKey === "weekly") {
    let runningWeight = getFirstValueEntry(series)?.weight ?? 0;

    return weeklyLoss
      .filter((entry) => !cutoff || entry.date >= cutoff)
      .map((entry) => ({
        ...entry,
        marketClose: runningWeight - entry.value,
        color: entry.value >= 0 ? COLORS.loss : COLORS.gain
      }))
      .map((entry) => {
        runningWeight = entry.marketClose;
        return entry;
      });
  }

  if (metricKey === "rolling28") {
    let runningWeight = getFirstValueEntry(series)?.weight ?? 0;

    return rolling28
      .filter((entry) => !cutoff || entry.date >= cutoff)
      .map((entry) => ({
        ...entry,
        marketClose: runningWeight - entry.value,
        color: entry.value >= 0 ? COLORS.loss : COLORS.gain
      }))
      .map((entry) => {
        runningWeight = entry.marketClose;
        return entry;
      });
  }

  let previousWeight = null;

  return series
    .filter((entry) => !cutoff || entry.date >= cutoff)
    .map((entry) => {
      const isMissing = !Number.isFinite(entry.weight);
      const value = Number.isFinite(entry.diff) ? entry.diff : 0;
      const marketClose = Number.isFinite(entry.weight)
        ? entry.weight
        : previousWeight ?? getFirstValueEntry(series)?.weight ?? 0;

      previousWeight = marketClose;

      return {
        label: entry.isoDate,
        shortLabel: formatShortDate(entry.date),
        value,
        date: entry.date,
        isMissing,
        marketClose,
        color: isMissing
          ? "rgba(12, 60, 120, 0.18)"
          : value > 0
            ? COLORS.gain
            : value < 0
              ? COLORS.loss
              : COLORS.neutral
      };
    });
}

function renderMarketChart(canvas, entries, metricKey) {
  const candles = buildCandlesFromEntries(entries);

  drawCandlestickChart(canvas, candles, {
    yFormatter: (value) => `${formatSignedWeight(value)} kg`,
    xTickFormatter: (item, index, items) => filterBarAxisLabel(item.shortLabel || item.label, index, items.length),
    minHeight: 220
  });
}

function buildCandlesFromEntries(entries) {
  let previousClose = entries[0]?.marketClose ?? 0;

  return entries.map((entry, index) => {
    const close = Number.isFinite(entry.marketClose) ? entry.marketClose : previousClose;
    const open = index === 0 ? close : previousClose;
    const spread = Math.abs(close - open);
    const wickPadding = spread === 0 ? 0.08 : Math.max(0.04, spread * 0.18);
    const high = Math.max(open, close) + wickPadding;
    const low = Math.min(open, close) - wickPadding;
    const volume = Math.abs(entry.value ?? 0);
    previousClose = close;

    return {
      label: entry.label,
      shortLabel: entry.shortLabel,
      open,
      high,
      low,
      close,
      volume,
      color: close >= open ? COLORS.gain : COLORS.loss
    };
  });
}

function renderProjection(series, regression, goalEstimate) {
  const summary = document.getElementById("projectionSummary");
  const latestEntry = getLatestValueEntry(series);
  const trendSeries = series.map((entry, index) => (
    Number.isFinite(regression.slope) && Number.isFinite(regression.intercept) && Number.isFinite(entry.ma7)
      ? regression.intercept + regression.slope * index
      : null
  ));
  const futureDays = goalEstimate.daysRemaining ? Math.min(goalEstimate.daysRemaining, 365) : 0;
  const futureProjection = [];

  if (latestEntry && Number.isFinite(regression.slope) && Number.isFinite(regression.intercept)) {
    const latestIndex = series.length - 1;

    for (let day = 1; day <= futureDays; day += 1) {
      futureProjection.push({
        label: formatShortDate(addDays(latestEntry.date, day)),
        value: regression.intercept + regression.slope * (latestIndex + day)
      });
    }
  }

  summary.querySelector(".projection-value").textContent = Number.isFinite(regression.slope)
    ? `${formatSignedWeight(regression.slope * 7)} kg / semaine`
    : "--";

  if (goalEstimate.estimatedDate) {
    summary.querySelector(".projection-detail").textContent = goalEstimate.daysRemaining === 0
      ? `Objectif ${formatWeight(POIDS_OBJECTIF)} kg deja atteint.`
      : `Projection au ${formatDate(goalEstimate.estimatedDate)} (${goalEstimate.daysRemaining} jours).`;
  } else {
    summary.querySelector(".projection-detail").textContent = "Projection indisponible avec la tendance actuelle.";
  }

  const canvas = document.getElementById("projectionChart");
  const labels = [
    ...series.map((entry) => entry.isoDate),
    ...futureProjection.map((entry) => entry.label)
  ];
  const ma7Values = [...series.map((entry) => entry.ma7), ...new Array(futureProjection.length).fill(null)];
  const trendValues = [...trendSeries, ...futureProjection.map((entry) => entry.value)];
  const goalValues = labels.map(() => POIDS_OBJECTIF);

  drawLineChart(canvas, [
    {
      label: "MA7",
      values: ma7Values,
      color: COLORS.ma7,
      lineWidth: 2.4,
      smooth: true,
      connectGaps: true
    },
    {
      label: "Projection",
      values: trendValues,
      color: COLORS.raw,
      lineWidth: 2,
      smooth: false,
      dash: [6, 6],
      connectGaps: true
    },
    {
      label: "Objectif",
      values: goalValues,
      color: COLORS.ma28,
      lineWidth: 1.6,
      smooth: false,
      dash: [4, 4],
      connectGaps: true
    }
  ], {
    labels,
    yFormatter: (value) => `${formatWeight(value)} kg`,
    xTickFormatter: (label, index, allLabels) => filterLineAxisLabel(label, index, allLabels),
    minHeight: 210
  });
}

function setupCanvasRedraw(canvas) {
  if (canvas.__resizeObserver) {
    return;
  }

  const observer = new ResizeObserver(() => renderCanvasChart(canvas));
  observer.observe(canvas.parentElement);
  canvas.__resizeObserver = observer;
}

function renderCanvasChart(canvas) {
  const chartType = canvas.__chartType;

  if (!chartType || !canvas.__chartData) {
    return;
  }

  const wrapper = canvas.parentElement;
  const wrapperStyle = window.getComputedStyle(wrapper);
  const minHeight = canvas.__chartData.options?.minHeight || 220;
  const paddingX = Number.parseFloat(wrapperStyle.paddingLeft) + Number.parseFloat(wrapperStyle.paddingRight);
  const paddingY = Number.parseFloat(wrapperStyle.paddingTop) + Number.parseFloat(wrapperStyle.paddingBottom);
  const cssWidth = Math.max(160, Math.round(wrapper.clientWidth - paddingX));
  const fallbackHeight = Math.max(120, minHeight - Math.round(paddingY));
  const cssHeight = Math.max(fallbackHeight, Math.round(wrapper.clientHeight - paddingY) || fallbackHeight);
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);

  if (chartType === "line") {
    renderLineChartToCanvas(context, cssWidth, cssHeight, canvas.__chartData.datasets, canvas.__chartData.options);
    return;
  }

  if (chartType === "candles") {
    renderCandlestickChartToCanvas(context, cssWidth, cssHeight, canvas.__chartData.data, canvas.__chartData.options);
    return;
  }

  renderBarChartToCanvas(context, cssWidth, cssHeight, canvas.__chartData.data, canvas.__chartData.options);
}

function renderLineChartToCanvas(context, width, height, datasets, options) {
  const padding = { top: 18, right: 10, bottom: 34, left: 50 };
  const plotWidth = Math.max(10, width - padding.left - padding.right);
  const plotHeight = Math.max(10, height - padding.top - padding.bottom);
  const flatValues = datasets.flatMap((dataset) => dataset.values.filter(Number.isFinite));

  if (!flatValues.length) {
    drawEmptyState(context, width, height, "Donnees insuffisantes");
    return;
  }

  let minValue = Math.min(...flatValues);
  let maxValue = Math.max(...flatValues);

  if (minValue === maxValue) {
    minValue -= 1;
    maxValue += 1;
  }

  const range = maxValue - minValue;
  minValue -= range * 0.08;
  maxValue += range * 0.08;

  const maxLength = Math.max(...datasets.map((dataset) => dataset.values.length), 0);
  const yForValue = (value) => padding.top + plotHeight - ((value - minValue) / (maxValue - minValue)) * plotHeight;
  const xForIndex = (index) => padding.left + (maxLength <= 1 ? plotWidth / 2 : (index / (maxLength - 1)) * plotWidth);

  context.strokeStyle = COLORS.axis;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(padding.left, padding.top);
  context.lineTo(padding.left, padding.top + plotHeight);
  context.lineTo(padding.left + plotWidth, padding.top + plotHeight);
  context.stroke();

  const ticks = 4;
  context.fillStyle = COLORS.muted;
  context.font = "12px Avenir Next, Segoe UI, sans-serif";
  context.textAlign = "right";
  context.textBaseline = "middle";

  for (let tick = 0; tick <= ticks; tick += 1) {
    const ratio = tick / ticks;
    const y = padding.top + plotHeight - ratio * plotHeight;
    const value = minValue + ratio * (maxValue - minValue);
    context.strokeStyle = COLORS.grid;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(padding.left + plotWidth, y);
    context.stroke();
    context.fillText(options.yFormatter ? options.yFormatter(value) : formatWeight(value), padding.left - 8, y);
  }

  const labels = options.labels || [];
  const tickStep = Math.max(1, Math.ceil(labels.length / 5));
  context.textAlign = "center";
  context.textBaseline = "top";

  labels.forEach((label, index) => {
    if (index % tickStep !== 0 && index !== labels.length - 1) {
      return;
    }

    const x = xForIndex(index);
    const renderedLabel = options.xTickFormatter ? options.xTickFormatter(label, index, labels) : label;

    if (!renderedLabel) {
      return;
    }

    context.fillStyle = COLORS.muted;
    context.fillText(renderedLabel, x, padding.top + plotHeight + 10);
  });

  datasets.forEach((dataset) => {
    const points = dataset.values.map((value, index) => (
      Number.isFinite(value) ? { x: xForIndex(index), y: yForValue(value) } : null
    ));
    const segments = dataset.connectGaps === false ? splitContinuousPoints(points) : [points.filter(Boolean)];

    context.save();
    context.strokeStyle = dataset.color || COLORS.text;
    context.lineWidth = dataset.lineWidth || 2;
    context.lineJoin = "round";
    context.lineCap = "round";

    if (dataset.dash) {
      context.setLineDash(dataset.dash);
    }

    segments.forEach((segment) => {
      if (!segment.length) {
        return;
      }

      if (dataset.fillArea) {
        const baseY = dataset.fillToZero && minValue <= 0 && maxValue >= 0
          ? yForValue(0)
          : padding.top + plotHeight;
        context.save();
        context.fillStyle = dataset.fillColor || "rgba(255, 255, 255, 0.08)";
        context.beginPath();
        context.moveTo(segment[0].x, baseY);
        context.lineTo(segment[0].x, segment[0].y);

        if (dataset.smooth && segment.length > 2) {
          for (let index = 0; index < segment.length - 1; index += 1) {
            const current = segment[index];
            const next = segment[index + 1];
            const controlX = (current.x + next.x) / 2;
            context.quadraticCurveTo(current.x, current.y, controlX, (current.y + next.y) / 2);
          }

          const last = segment[segment.length - 1];
          context.lineTo(last.x, last.y);
        } else {
          for (let index = 1; index < segment.length; index += 1) {
            context.lineTo(segment[index].x, segment[index].y);
          }
        }

        context.lineTo(segment[segment.length - 1].x, baseY);
        context.closePath();
        context.fill();
        context.restore();
      }

      context.beginPath();
      context.moveTo(segment[0].x, segment[0].y);

      if (dataset.smooth && segment.length > 2) {
        for (let index = 0; index < segment.length - 1; index += 1) {
          const current = segment[index];
          const next = segment[index + 1];
          const controlX = (current.x + next.x) / 2;
          context.quadraticCurveTo(current.x, current.y, controlX, (current.y + next.y) / 2);
        }

        const last = segment[segment.length - 1];
        context.lineTo(last.x, last.y);
      } else {
        for (let index = 1; index < segment.length; index += 1) {
          context.lineTo(segment[index].x, segment[index].y);
        }
      }

      context.stroke();

      if (dataset.showPoints) {
        segment.forEach((point) => {
          context.fillStyle = dataset.color || COLORS.text;
          context.beginPath();
          context.arc(point.x, point.y, dataset.pointRadius || 2.8, 0, Math.PI * 2);
          context.fill();
        });
      }
    });

    context.restore();
  });
}

function renderBarChartToCanvas(context, width, height, data, options) {
  const padding = { top: 18, right: 10, bottom: 36, left: 50 };
  const plotWidth = Math.max(10, width - padding.left - padding.right);
  const plotHeight = Math.max(10, height - padding.top - padding.bottom);

  if (!data.length) {
    drawEmptyState(context, width, height, "Donnees insuffisantes");
    return;
  }

  const values = data.map((item) => item.value).filter(Number.isFinite);

  if (!values.length) {
    drawEmptyState(context, width, height, "Donnees insuffisantes");
    return;
  }

  const minValue = Math.min(0, ...values);
  const maxValue = Math.max(0, ...values);
  const range = maxValue - minValue || 1;
  const yForValue = (value) => padding.top + plotHeight - ((value - minValue) / range) * plotHeight;
  const zeroY = yForValue(0);

  context.strokeStyle = COLORS.axis;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(padding.left, padding.top);
  context.lineTo(padding.left, padding.top + plotHeight);
  context.lineTo(padding.left + plotWidth, padding.top + plotHeight);
  context.stroke();

  context.strokeStyle = COLORS.grid;
  context.beginPath();
  context.moveTo(padding.left, zeroY);
  context.lineTo(padding.left + plotWidth, zeroY);
  context.stroke();

  context.fillStyle = COLORS.muted;
  context.font = "12px Avenir Next, Segoe UI, sans-serif";
  context.textAlign = "right";
  context.textBaseline = "middle";
  context.fillText(options.yFormatter ? options.yFormatter(maxValue) : formatSignedWeight(maxValue), padding.left - 8, padding.top);
  context.fillText(options.yFormatter ? options.yFormatter(0) : "0", padding.left - 8, zeroY);
  context.fillText(options.yFormatter ? options.yFormatter(minValue) : formatSignedWeight(minValue), padding.left - 8, padding.top + plotHeight);

  const gap = Math.max(2, plotWidth / Math.max(data.length, 1) * 0.16);
  const barWidth = Math.max(3, (plotWidth - gap * (data.length - 1)) / data.length);

  data.forEach((item, index) => {
    const x = padding.left + index * (barWidth + gap);
    if (!Number.isFinite(item.value)) {
      context.strokeStyle = item.color || COLORS.grid;
      context.lineWidth = 1;
      context.strokeRect(x, zeroY - 3, barWidth, 6);
      return;
    }

    const y = yForValue(item.value);
    const barTop = Math.min(y, zeroY);
    const barHeight = Math.max(2, Math.abs(zeroY - y));

    context.fillStyle = item.color || (item.value >= 0 ? COLORS.loss : COLORS.gain);
    roundRect(context, x, barTop, barWidth, barHeight, 3);
    context.fill();
  });

  const tickStep = Math.max(1, Math.ceil(data.length / 5));
  context.textAlign = "center";
  context.textBaseline = "top";

  data.forEach((item, index) => {
    if (index % tickStep !== 0 && index !== data.length - 1) {
      return;
    }

    const x = padding.left + index * (barWidth + gap) + barWidth / 2;
    const label = options.xTickFormatter ? options.xTickFormatter(item, index, data) : item.shortLabel || item.label;

    if (!label) {
      return;
    }

    context.fillStyle = COLORS.muted;
    context.fillText(label, x, padding.top + plotHeight + 10);
  });
}

function renderCandlestickChartToCanvas(context, width, height, data, options) {
  const padding = { top: 18, right: 10, bottom: 36, left: 56 };
  const plotWidth = Math.max(10, width - padding.left - padding.right);
  const plotHeight = Math.max(10, height - padding.top - padding.bottom);

  if (!data.length) {
    drawEmptyState(context, width, height, "Donnees insuffisantes");
    return;
  }

  const prices = data.flatMap((item) => [item.low, item.high]).filter(Number.isFinite);
  const volumes = data.map((item) => item.volume).filter(Number.isFinite);

  if (!prices.length) {
    drawEmptyState(context, width, height, "Donnees insuffisantes");
    return;
  }

  let minValue = Math.min(...prices);
  let maxValue = Math.max(...prices);

  if (minValue === maxValue) {
    minValue -= 1;
    maxValue += 1;
  }

  const range = maxValue - minValue;
  minValue -= range * 0.08;
  maxValue += range * 0.08;

  const volumeHeight = Math.max(32, Math.round(plotHeight * 0.22));
  const priceHeight = plotHeight - volumeHeight - 10;
  const maxVolume = Math.max(...volumes, 1);
  const yForValue = (value) => padding.top + priceHeight - ((value - minValue) / (maxValue - minValue)) * priceHeight;

  context.strokeStyle = COLORS.axis;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(padding.left, padding.top);
  context.lineTo(padding.left, padding.top + plotHeight);
  context.lineTo(padding.left + plotWidth, padding.top + plotHeight);
  context.stroke();

  const ticks = 5;
  context.fillStyle = COLORS.muted;
  context.font = "12px Avenir Next, Segoe UI, sans-serif";
  context.textAlign = "right";
  context.textBaseline = "middle";

  for (let tick = 0; tick <= ticks; tick += 1) {
    const ratio = tick / ticks;
    const y = padding.top + priceHeight - ratio * priceHeight;
    const value = minValue + ratio * (maxValue - minValue);
    context.strokeStyle = COLORS.grid;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(padding.left + plotWidth, y);
    context.stroke();
    context.fillText(options.yFormatter ? options.yFormatter(value) : formatSignedWeight(value), padding.left - 8, y);
  }

  const slotWidth = plotWidth / Math.max(data.length, 1);
  const bodyWidth = Math.max(4, Math.min(18, slotWidth * 0.58));

  data.forEach((item, index) => {
    const centerX = padding.left + slotWidth * index + slotWidth / 2;
    const openY = yForValue(item.open);
    const closeY = yForValue(item.close);
    const highY = yForValue(item.high);
    const lowY = yForValue(item.low);
    const topY = Math.min(openY, closeY);
    const bodyHeight = Math.max(2, Math.abs(closeY - openY));
    const volumeBarHeight = (item.volume / maxVolume) * volumeHeight;
    const volumeY = padding.top + priceHeight + 10 + (volumeHeight - volumeBarHeight);

    context.strokeStyle = item.color;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(centerX, highY);
    context.lineTo(centerX, lowY);
    context.stroke();

    context.fillStyle = item.color;
    roundRect(context, centerX - bodyWidth / 2, topY, bodyWidth, bodyHeight, 2);
    context.fill();

    context.globalAlpha = 0.28;
    context.fillRect(centerX - bodyWidth / 2, volumeY, bodyWidth, volumeBarHeight);
    context.globalAlpha = 1;
  });

  context.textAlign = "center";
  context.textBaseline = "top";
  const tickStep = Math.max(1, Math.ceil(data.length / 5));

  data.forEach((item, index) => {
    if (index % tickStep !== 0 && index !== data.length - 1) {
      return;
    }

    const centerX = padding.left + slotWidth * index + slotWidth / 2;
    const label = options.xTickFormatter ? options.xTickFormatter(item, index, data) : item.shortLabel || item.label;

    if (!label) {
      return;
    }

    context.fillStyle = COLORS.muted;
    context.fillText(label, centerX, padding.top + plotHeight + 10);
  });
}

function buildContinuousSeries(records) {
  const byDate = new Map(records.map((record) => [record.isoDate, record.weight]));
  const start = records[0].date;
  const end = records[records.length - 1].date;
  const days = differenceInDays(end, start);
  const series = [];

  for (let offset = 0; offset <= days; offset += 1) {
    const date = addDays(start, offset);
    const isoDate = formatISODate(date);
    const weight = byDate.has(isoDate) ? byDate.get(isoDate) : null;

    series.push({
      date,
      isoDate,
      weight: Number.isFinite(weight) ? weight : null
    });
  }

  return series;
}

function computeDailyDiff(series, index) {
  const current = series[index];

  if (!Number.isFinite(current.weight)) {
    return null;
  }

  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (Number.isFinite(series[cursor].weight)) {
      return sanitizeNumber(current.weight - series[cursor].weight);
    }
  }

  return null;
}

function getFirstValueEntry(series) {
  return series.find((entry) => Number.isFinite(entry.weight)) || null;
}

function getLatestValueEntry(series) {
  return [...series].reverse().find((entry) => Number.isFinite(entry.weight)) || null;
}

function filterLineAxisLabel(label, index, labels) {
  const every = Math.max(1, Math.ceil(labels.length / 5));
  return index % every === 0 || index === labels.length - 1 ? formatAxisDate(label) : "";
}

function filterBarAxisLabel(label, index, total) {
  const every = Math.max(1, Math.ceil(total / 5));
  return index % every === 0 || index === total - 1 ? label : "";
}

function getBarsMetricLabel(metricKey) {
  if (metricKey === "weekly") {
    return "Perte hebdomadaire";
  }

  if (metricKey === "rolling28") {
    return "Perte glissante 28 jours";
  }

  return "Variation journaliere";
}

function getBarsRangeLabel(rangeKey) {
  if (rangeKey === "28d") {
    return "28 jours";
  }

  if (rangeKey === "6m") {
    return "6 mois";
  }

  if (rangeKey === "1y") {
    return "1 an";
  }

  if (rangeKey === "all") {
    return "depuis le debut";
  }

  return "7 jours";
}

function splitContinuousPoints(points) {
  const segments = [];
  let currentSegment = [];

  points.forEach((point) => {
    if (!point) {
      if (currentSegment.length) {
        segments.push(currentSegment);
        currentSegment = [];
      }
      return;
    }

    currentSegment.push(point);
  });

  if (currentSegment.length) {
    segments.push(currentSegment);
  }

  return segments;
}

function drawEmptyState(context, width, height, text) {
  context.fillStyle = COLORS.muted;
  context.font = "13px Avenir Next, Segoe UI, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, width / 2, height / 2);
}

function roundRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function buildHeatmapTooltip(entry) {
  if (!Number.isFinite(entry.weight)) {
    return `${formatDate(entry.date)}\nAucune mesure`;
  }

  const diffLabel = Number.isFinite(entry.diff) ? `${formatSignedWeight(entry.diff)} kg` : "N/A";
  return `${formatDate(entry.date)}\n${formatWeight(entry.weight)} kg\nDiff: ${diffLabel}`;
}

function getHeatmapMonthLabel(weekStart, previousMonthKey, firstDate) {
  const containsFirstDate = differenceInDays(weekStart, firstDate) <= 0 && differenceInDays(addDays(weekStart, 6), firstDate) >= 0;
  const monthStartInWeek = Array.from({ length: 7 }, (_, offset) => addDays(weekStart, offset))
    .find((date) => date.getUTCDate() === 1);
  const labelDate = monthStartInWeek || (containsFirstDate ? firstDate : null);

  if (!labelDate) {
    return { text: "", key: previousMonthKey };
  }

  const labelKey = `${labelDate.getUTCFullYear()}-${labelDate.getUTCMonth()}`;

  if (labelKey === previousMonthKey) {
    return { text: "", key: previousMonthKey };
  }

  if (labelDate.getUTCMonth() === 0 || containsFirstDate && labelDate.getUTCFullYear() !== weekStart.getUTCFullYear()) {
    return {
      text: String(labelDate.getUTCFullYear()),
      key: labelKey
    };
  }

  return {
    text: new Intl.DateTimeFormat("fr-FR", {
      month: "short",
      timeZone: "UTC"
    }).format(labelDate),
    key: labelKey
  };
}

function setError(message) {
  const statusText = document.getElementById("statusText");
  statusText.textContent = message;
  statusText.classList.add("error-state");
}

function formatWeight(value) {
  return new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: NB_DECIMALES,
    maximumFractionDigits: NB_DECIMALES
  }).format(value);
}

function formatSignedWeight(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }

  const absolute = formatWeight(Math.abs(value));
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${absolute}`;
}

function formatDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "--";
  }

  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC"
  }).format(date);
}

function formatAxisDate(label) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(label)) {
    return label.slice(5).replace("-", "/");
  }

  return label;
}

function sanitizeNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function createUTCDate(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function differenceInDays(a, b) {
  return Math.round((a.getTime() - b.getTime()) / DAY_MS);
}

function startOfISOWeek(date) {
  const day = (date.getUTCDay() + 6) % 7;
  return addDays(date, -day);
}

function endOfISOWeek(date) {
  const day = (date.getUTCDay() + 6) % 7;
  return addDays(date, 6 - day);
}

function formatISODate(date) {
  return date.toISOString().slice(0, 10);
}

function getISOWeekKey(date) {
  const temp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = temp.getUTCDay() || 7;
  temp.setUTCDate(temp.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(temp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((temp - yearStart) / DAY_MS) + 1) / 7);
  return `${temp.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}
