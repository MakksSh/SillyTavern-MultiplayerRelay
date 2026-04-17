const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

const DEFAULT_LEVEL = 'info';

function getCurrentLevel() {
  const candidate = String(process.env.LOG_LEVEL || DEFAULT_LEVEL).toLowerCase();
  return LEVELS[candidate] ? candidate : DEFAULT_LEVEL;
}

function normalizeValue(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, normalizeValue(nestedValue)]),
    );
  }

  return value;
}

function shouldLog(level) {
  return LEVELS[level] >= LEVELS[getCurrentLevel()];
}

function write(level, event, context = {}) {
  if (!shouldLog(level)) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...normalizeValue(context),
  };

  const serialized = JSON.stringify(payload);
  if (level === 'error') {
    console.error(serialized);
    return;
  }

  console.log(serialized);
}

module.exports = {
  debug(event, context) {
    write('debug', event, context);
  },
  info(event, context) {
    write('info', event, context);
  },
  warn(event, context) {
    write('warn', event, context);
  },
  error(event, context) {
    write('error', event, context);
  },
};
