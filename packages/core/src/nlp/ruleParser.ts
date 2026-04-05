import type { DynamicIntent, EnvironmentName, IntentDef } from "../types/intent.js";
import { loadRules, loadIntents } from "../utils/config.js";
import { normalizePath } from "../utils/wslPaths.js";

export function parseByRules(rawText: string): DynamicIntent | null {
  const rules = loadRules();
  const intents = loadIntents();
  const text = rawText.trim().toLowerCase();

  // Pre-check: casual conversation / greetings / social
  const casualPatterns: Array<{ pattern: RegExp; intent: string }> = [
    { pattern: /^(hey|hi|hello|howdy|yo|sup|what'?s up|good (morning|afternoon|evening|night)|greetings)\s*[!?.]*$/i, intent: "chat.greeting" },
    { pattern: /^how (are you|you doing|is it going|do you feel|are things)/i, intent: "chat.howru" },
    { pattern: /^(how'?s it going|what'?s good|you good|you ok)\s*[!?.]*$/i, intent: "chat.howru" },
    { pattern: /^(thanks|thank you|thx|cheers|appreciate it|good job|nice work|well done|great job|awesome|perfect|excellent)\s*[!?.]*$/i, intent: "chat.thanks" },
    { pattern: /^(bye|goodbye|see you|later|gotta go|peace|cya|goodnight|good night|take care)\s*[!?.]*$/i, intent: "chat.bye" },
    { pattern: /^(who are you|what are you|tell me about yourself|what is notoken)/i, intent: "chat.about" },
    { pattern: /^(tell me a joke|say something funny|make me laugh|joke)\s*[!?.]*$/i, intent: "chat.joke" },
    { pattern: /^(i'?m (bored|tired|frustrated|confused|stuck|lost))/i, intent: "chat.empathy" },
    { pattern: /^(this (sucks|is broken|doesn'?t work|is frustrating))/i, intent: "chat.empathy" },
    { pattern: /^(what do you think|your opinion|do you like|which is better)/i, intent: "chat.opinion" },
    // Compliments
    { pattern: /^(you('re| are) (awesome|great|amazing|the best|cool|smart|helpful|incredible))/i, intent: "chat.compliment" },
    { pattern: /^(nice|love it|love you|love this|you rock|brilliant)/i, intent: "chat.compliment" },
    // Insults (playful)
    { pattern: /^(you('re| are) (stupid|dumb|useless|terrible|bad|wrong|slow|broken))/i, intent: "chat.insult" },
    { pattern: /^(you suck|this sucks|worst|hate this)/i, intent: "chat.insult" },
    // What can you do / capabilities
    { pattern: /^(what (else )?can you do|show me what you can do|what are your (skills|capabilities|features))/i, intent: "chat.capabilities" },
    // Bored / entertain me
    { pattern: /^(i('m| am) bored|entertain me|do something (cool|fun|interesting)|surprise me|show me something)/i, intent: "chat.bored" },
    // Existential
    { pattern: /^(are you (alive|real|sentient|conscious|human|ai|a robot|a bot))/i, intent: "chat.existential" },
    { pattern: /^(do you (dream|sleep|feel|think|have feelings|have emotions))/i, intent: "chat.existential" },
    // Motivational
    { pattern: /^(motivate me|inspire me|give me a (quote|pep talk)|i need motivation)/i, intent: "chat.motivate" },
    // Facts / trivia
    { pattern: /^(tell me a fact|random fact|fun fact|did you know|trivia)/i, intent: "chat.fact" },
    // Easter eggs
    { pattern: /^(42|meaning of life|do a barrel roll|make me a sandwich|sudo make me a sandwich)/i, intent: "chat.easter" },
    { pattern: /^(what is the matrix|open the pod bay doors|i am your father|may the force)/i, intent: "chat.easter" },
    // Apology
    { pattern: /^(sorry|my bad|i('m| am) sorry|apologies|oops|my mistake)/i, intent: "chat.sorry" },
    // Agreement / affirmation (not pending action)
    { pattern: /^(cool|nice|ok cool|awesome|sweet|neat|dope|sick|rad|lit)\s*[!.]*$/i, intent: "chat.acknowledge" },
    // How old are you / version
    { pattern: /^(how old are you|when were you (made|born|created)|your (age|birthday|version))/i, intent: "chat.age" },
    // Favorite things
    { pattern: /^(what('s| is) your favorite|do you have a favorite)/i, intent: "chat.favorite" },
    // Riddles
    { pattern: /^(tell me a riddle|riddle|give me a riddle|riddle me|got a riddle|brain teaser)\s*[!?.]*$/i, intent: "chat.riddle" },
    // Today in history
    { pattern: /^(what happened today|today in history|on this day|this day in history|historical fact|history fact)\s*[!?.]*$/i, intent: "chat.history_today" },
    // Task management (natural language)
    { pattern: /^(what'?s running in (the )?background|any(thing)? running in (the )?background|running tasks|background tasks|active tasks|show (my )?tasks|what tasks)\s*[!?.]*$/i, intent: "notoken.jobs" },
    { pattern: /^(cancel|stop|kill|abort)\s+(it|that|everything|all( tasks)?|the (task|job|scan|download))\s*$/i, intent: "notoken.cancel" },
    { pattern: /^(cancel|stop|kill) (task|job) #?\d+$/i, intent: "notoken.cancel" },
  ];
  for (const { pattern, intent } of casualPatterns) {
    if (pattern.test(text)) return { intent, confidence: 0.95, rawText, fields: {} };
  }

  // Pre-check: negation detection — "don't restart nginx", "do not check disk", "never mind"
  // Note: "stop <service>" is a legitimate stop command, so we only match "stop" when
  // followed by a verb (e.g. "stop checking") or on its own, not "stop <noun>"
  if (/^(don'?t|do not|no don'?t)\s+/i.test(text)
      || /^(cancel|never mind|abort|nevermind)$/i.test(text)
      || /^never\s+(do|run|execute|mind)/i.test(text)
      || /^stop\s+(doing|checking|running|monitoring|that|it)(\s|$)/i.test(text)) {
    return { intent: "notoken.cancel", confidence: 0.95, rawText, fields: {} };
  }

  // Pre-check: status queries → notoken.status (not knowledge.lookup or service.status)
  if (/^(what is |what's |show |check |give me )?(the )?(system |computer |machine |notoken )?status( of)?( this| the| my)?( machine| computer| system| server)?[?.!]?$/.test(text)
      || /^(how is |how's )?(this |the |my )?(system|machine|computer|server) doing/.test(text)
      || /^system status$/.test(text)) {
    const statusDef = intents.find(i => i.name === "notoken.status");
    if (statusDef) return { intent: "notoken.status", confidence: 0.95, rawText, fields: {} };
  }

  // Pre-check: server/system queries — "what is load", "what is cpu usage", "what is memory", "how much ram"
  if (/^(what is |what's |show |check |how much |how's )?(the )?(load|cpu|cpu usage|uptime|server load)( right now| currently| on this)?\??$/.test(text)
      || /^(what is |show )?(the )?(load|cpu) (average|right now|currently)/.test(text)) {
    return { intent: "server.uptime", confidence: 0.9, rawText, fields: {} };
  }
  // "what is using heavy cpu" / "what is eating cpu" / "any heavy load processes"
  if (/\b(what|which|any)\b.*(using|eating|taking|hogging|consuming)\b.*(cpu|processing|resources|memory|ram|load)\b/i.test(text)
      || /\b(heavy|high)\s+(load|cpu|processing|processes)\b/i.test(text)) {
    return { intent: "process.list", confidence: 0.9, rawText, fields: {} };
  }
  if (/^(what is |what's |show |check |how much )?(the )?(memory|ram|memory usage|ram usage)( right now| left| free| used| currently)?\??$/.test(text)) {
    return { intent: "server.check_memory", confidence: 0.9, rawText, fields: {} };
  }
  if (/^(what is |what's |show |check |how much )?(the |my )?(disk|disk space|storage|space|drives)( left| free| used| right now| currently)?\??$/.test(text)) {
    return { intent: "server.check_disk", confidence: 0.9, rawText, fields: {} };
  }

  // Pre-check: common conversational queries that get misrouted

  // Weather
  if (/\b(weather|forecast|temperature|rain|snow|sunny|cloudy)\b/i.test(text)
      && !/\b(log|error|server|disk)\b/i.test(text)) {
    const locMatch = text.match(/(?:weather|forecast|temperature)\s+(?:in|at|for|of)\s+(.+?)(?:\?|$)/i)
      ?? text.match(/(?:in|at|for)\s+(.+?)(?:\s+weather|\s+forecast|\?|$)/i);
    return { intent: "weather.current", confidence: 0.95, rawText, fields: locMatch ? { location: locMatch[1].trim() } : {} };
  }

  // News
  if (/^(what is |what's |show me )?(the )?(latest |today's |current )?(news|headlines|top stories)/i.test(text)
      || /^(any |what's? )?news( today)?\??$/i.test(text)) {
    return { intent: "news.headlines", confidence: 0.9, rawText, fields: {} };
  }

  // Database size
  if (/\b(how big|size of|how much space)\b.*\b(database|db|mysql|postgres|mongo)\b/i.test(text)
      || /\b(database|db)\s+(size|storage|disk|space)\b/i.test(text)) {
    return { intent: "db.size", confidence: 0.9, rawText, fields: {} };
  }

  // Time/date
  if (/^(what is |what's )?(the )?(time|date|day|today)( right now| today)?\??$/.test(text)) {
    return { intent: "system.datetime", confidence: 0.9, rawText, fields: {} };
  }

  // Help / capabilities
  // Only match bare help — not "ask openclaw what can you do"
  if (/^(help|help me|what can you do|what do you do|show me help|commands)\??$/.test(text) && !text.includes("openclaw") && !text.includes("claw")) {
    return { intent: "notoken.help", confidence: 0.95, rawText, fields: {} };
  }

  // History / undo
  if (/^(show me |what is )?(my )?history$/.test(text) || /^what did i (do|run|ask) (last|before|previously)/.test(text)) {
    return { intent: "notoken.history", confidence: 0.9, rawText, fields: {} };
  }
  if (/^undo( that| last| it)?$/.test(text)) {
    return { intent: "notoken.undo", confidence: 0.9, rawText, fields: {} };
  }

  // Who am I / logged in users
  if (/^who am i\??$/.test(text) || /^(what is |what's )?my (user|username|login)\??$/.test(text)) {
    return { intent: "user.whoami", confidence: 0.9, rawText, fields: {} };
  }
  if (/^who (else )?(is |are )?(logged in|online|connected)\??$/.test(text)) {
    return { intent: "user.who", confidence: 0.9, rawText, fields: {} };
  }

  // Running services
  if (/^(show me |list |what are )?(the )?(running |active )?services$/.test(text)) {
    return { intent: "service.list", confidence: 0.9, rawText, fields: {} };
  }

  // Network: ip address, bandwidth, speed, slow
  if (/^(what is |what's |show )?(my )?(ip|ip address|public ip)\??$/.test(text)) {
    return { intent: "network.ip", confidence: 0.9, rawText, fields: {} };
  }
  if (/\b(bandwidth|network speed|connection speed|speed test|speedtest)\b/i.test(text) || /^(is the )?network slow\??$/.test(text)) {
    return { intent: "network.speedtest", confidence: 0.9, rawText, fields: {} };
  }

  // Block/unblock IP → firewall
  if (/^(block|unblock|ban|unban)\s+(this\s+)?ip/i.test(text) || /^(block|unblock|ban|unban)\s+\d+\.\d+/i.test(text)) {
    return { intent: "firewall.block_ip", confidence: 0.9, rawText, fields: {} };
  }

  // Docker queries with "show me"
  if (/^(show me |list )?(docker )?(images|containers)$/.test(text) || /^what (containers|images) are (running|there)\??$/.test(text)) {
    const isImages = /images/.test(text);
    return { intent: isImages ? "docker.images" : "docker.list", confidence: 0.9, rawText, fields: {} };
  }

  // Large files
  if (/^find (large|big|huge) files$/.test(text) || /\b(large|big|huge) files\b/.test(text)) {
    return { intent: "disk.scan", confidence: 0.9, rawText, fields: {} };
  }

  // Error logs
  if (/^(show me |check |any )?(the )?(error|recent) logs$/.test(text) || /^any errors in (the )?logs\??$/.test(text)) {
    return { intent: "logs.errors", confidence: 0.9, rawText, fields: {} };
  }

  // Clear screen
  if (/^clear( the)?( screen| terminal)?$/.test(text)) {
    return { intent: "shell.clear", confidence: 0.95, rawText, fields: {} };
  }

  // Disk IO
  if (/^(show me |check )?(disk|io|disk io|iops)( stats| usage)?\??$/.test(text)) {
    return { intent: "server.check_disk", confidence: 0.9, rawText, fields: {} };
  }

  // Website up check
  if (/^(check if |is )?(the |my )?(website|site|server|page) (is )?(up|down|running|alive|responding)\??$/.test(text)) {
    return { intent: "network.curl", confidence: 0.9, rawText, fields: {} };
  }

  // Pre-check: attack/security/ddos queries → security.scan
  if (/\b(attack|ddos|brute.?force|intrusion|hacked|breach|compromised|unauthorized|virus|malware|rootkit)\b/i.test(text)
      || /\b(are we|am i|is .* being)\s+(under\s+)?attack/i.test(text)
      || /\b(suspicious|failed)\s+(activity|login|connection|traffic|access)/i.test(text)
      || /\bwho is (attacking|hacking|connecting|hitting)/i.test(text)
      || /\bcheck (for )?(attacks|security|intrusion|viruses|malware)/i.test(text)
      || /\b(any )?(viruses|malware|rootkits?) (on|in|running)/i.test(text)) {
    return { intent: "security.scan", confidence: 0.95, rawText, fields: {} };
  }

  // Pre-check: "can you generate an image" → ai.generate_image (not ai.image_status)
  if (/^(can you|could you|are you able to|do you)\s+(generate|create|make|draw)\s+(an?\s+)?(image|picture|photo|art)/i.test(text)) {
    return { intent: "ai.generate_image", confidence: 0.9, rawText, fields: {} };
  }

  // Pre-check: "cd /path" → shell cd (change directory)
  const cdMatch = text.match(/^cd\s+(\/\S+|~\S*|\.\S*)$/);
  if (cdMatch) {
    return { intent: "shell.cd", confidence: 0.95, rawText, fields: { path: cdMatch[1] } };
  }

  // Pre-check: "what is in my documents/folder/drive" → dir.list
  const whatIsInMatch = text.match(/^(?:what is |what's |show me what(?:'s| is) )in (?:my |the |this )?(.*?)(?:\?|$)/);
  if (whatIsInMatch) {
    const target = whatIsInMatch[1].trim();
    // Resolve common folder names
    const folderMap: Record<string, string> = {
      "documents": process.platform === "win32" ? "%USERPROFILE%\\Documents" : "~/Documents",
      "documents folder": process.platform === "win32" ? "%USERPROFILE%\\Documents" : "~/Documents",
      "downloads": process.platform === "win32" ? "%USERPROFILE%\\Downloads" : "~/Downloads",
      "downloads folder": process.platform === "win32" ? "%USERPROFILE%\\Downloads" : "~/Downloads",
      "desktop": process.platform === "win32" ? "%USERPROFILE%\\Desktop" : "~/Desktop",
      "home": "~",
      "home folder": "~",
      "home directory": "~",
      "root": "/",
      "root folder": "/",
      "root c drive": "/mnt/c/",
      "c drive": "/mnt/c/",
      "d drive": "/mnt/d/",
      "e drive": "/mnt/e/",
    };
    const path = folderMap[target] ?? target;
    if (target.includes("drive")) {
      return { intent: "disk.scan", confidence: 0.9, rawText, fields: { path } };
    }
    return { intent: "dir.list", confidence: 0.9, rawText, fields: { path } };
  }

  // Pre-check: "what projects are on this drive" → project.scan
  if (/\bwhat projects\b.*\b(on|in)\b.*\b(this|the|my|c|d)\b/.test(text)) {
    return { intent: "project.scan", confidence: 0.9, rawText, fields: { path: "." } };
  }

  // Pre-check: "what's on this drive" / "show me whats on this drive" → disk.scan
  if (/\b(what.?s|show me what.?s|what is) on (this|the|my|c|d) drive\b/.test(text)
      || /\bshow me (this|the|my) drive\b/.test(text)) {
    return { intent: "disk.scan", confidence: 0.9, rawText, fields: {} };
  }

  // Pre-check: "what files" / "what are files in this folder" → dir.list or project.detect
  if (/^(what are |what's in |show me |list |show )(the )?(files|contents)( in| of)?( this| the| my| current)?( folder| directory| dir| project)?[?.!]?$/.test(text)
      || /^(show me |list )(project |all )?files$/.test(text)) {
    const isDirList = text.includes("folder") || text.includes("directory") || text.includes("dir");
    const intentName = isDirList ? "dir.list" : "project.detect";
    return { intent: intentName, confidence: 0.9, rawText, fields: { path: "." } };
  }

  // Pre-check: "how is openclaw doing" / "status of openclaw" / "can you talk to openclaw"
  const howIsMatch = text.match(/^how(?:'s| is| are) (openclaw|claw|discord|ollama|notoken) (?:doing|going|running|working)/);
  if (howIsMatch) {
    const target = howIsMatch[1] === "claw" ? "openclaw" : howIsMatch[1];
    const intentName = target === "notoken" ? "notoken.status" : `${target}.status`;
    return { intent: intentName, confidence: 0.9, rawText, fields: {} };
  }
  // "status of X" / "can you talk to X" / "diagnose X" / "check X"
  // Also catches "can you talk to it" / "are you able to talk to it" with "it" passthrough
  const statusOfMatch = text.match(/(?:status of|check on|talk to|communicate with|connect to|reach|diagnos\w*)\s+(openclaw|claw|discord|ollama|notoken)\b/);
  if (statusOfMatch) {
    const target = statusOfMatch[1] === "claw" ? "openclaw" : statusOfMatch[1];
    const intentName = target === "notoken" ? "notoken.status" : `${target}.status`;
    return { intent: intentName, confidence: 0.9, rawText, fields: {} };
  }

  // Pre-check: "uninstall ollama" → ollama.uninstall (not generic package.uninstall)
  if (/\b(uninstall|remove|delete|get rid of)\s+ollama\b/i.test(text)) {
    return { intent: "ollama.uninstall", confidence: 0.95, rawText, fields: {} };
  }

  // Pre-check: "do we have X" / "is X installed" → tool.info or specific status
  const haveMatch = text.match(/\b(do we have|is|are)\s+(ollama|docker|nginx|node|python|git)\s+(installed|running|available|there|set ?up)\b/i)
    ?? text.match(/\b(do we have|do i have)\s+(ollama|docker|nginx|node|python|git)\b/i);
  if (haveMatch) {
    const tool = haveMatch[2].toLowerCase();
    if (tool === "ollama") return { intent: "ollama.status", confidence: 0.9, rawText, fields: {} };
    if (tool === "docker") return { intent: "docker.list", confidence: 0.9, rawText, fields: {} };
    return { intent: "tool.info", confidence: 0.9, rawText, fields: { tool } };
  }

  // Pre-check: file organization
  if (/\b(organize|sort|tidy|clean ?up|arrange|categorize)\b.*\b(files?|folder|directory|downloads?|this)\b/i.test(text)
      || /\b(files?|folder|directory|downloads?)\b.*\b(organize|sort|tidy|arrange|categorize)\b/i.test(text)) {
    return { intent: "files.organize", confidence: 0.9, rawText, fields: {} };
  }
  if (/\bwhere\s+(should|do|can)\s+i\s+put\b/i.test(text) || /\bwhere\s+does\s+this\s+(go|belong)\b/i.test(text)) {
    return { intent: "files.place", confidence: 0.9, rawText, fields: {} };
  }

  // Match intent by synonyms defined in intents.json
  const matched = matchIntent(text, intents);
  if (!matched) return null;

  const { def, matchedPhrase } = matched;

  // Extract fields based on the intent's field definitions
  const fields: Record<string, unknown> = {};
  let allRequiredFound = true;

  // First pass: extract typed fields (environment, service, number, branch)
  for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
    let value: unknown = undefined;

    switch (fieldDef.type) {
      case "environment":
        value = extractEnvironment(text, rules.environmentAliases);
        break;
      case "service":
        value = extractService(text, rules.serviceAliases, matchedPhrase);
        break;
      case "number":
        value = extractNumber(text);
        break;
      case "branch":
        value = extractBranch(text);
        break;
    }

    if (value !== undefined) {
      fields[fieldName] = value;
    }
  }

  // Second pass: extract string fields using context-aware extraction
  const stringFields = Object.entries(def.fields).filter(([, fd]) => fd.type === "string");
  if (stringFields.length > 0) {
    const extracted = extractStringFields(rawText, text, matchedPhrase, stringFields.map(([n]) => n), fields);
    for (const [k, v] of Object.entries(extracted)) {
      if (v !== undefined) fields[k] = v;
    }
  }

  // Apply defaults for missing fields
  for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
    if (fields[fieldName] === undefined && fieldDef.default !== undefined) {
      fields[fieldName] = fieldDef.default;
    }
    if (fields[fieldName] === undefined && fieldDef.required) {
      allRequiredFound = false;
    }
  }

  // Resolve logPaths if the intent uses them
  if (def.logPaths && fields.service) {
    const logPath = def.logPaths[fields.service as string];
    if (logPath) fields.logPath = logPath;
  }

  // Confidence scoring
  let confidence = 0.7;
  if (allRequiredFound) confidence += 0.15;
  if (matchedPhrase.length > 4) confidence += 0.05;
  confidence = Math.min(confidence, 0.95);

  return {
    intent: def.name,
    confidence,
    rawText,
    fields,
  };
}

/**
 * Extract string fields from natural language using preposition patterns.
 *
 * Handles patterns like:
 *   "copy nginx.conf to /root"       → source=nginx.conf, destination=/root
 *   "move app.log to /backup"        → source=app.log, destination=/backup
 *   "grep error in /var/log"         → query=error, path=/var/log
 *   "find *.conf in /etc"            → pattern=*.conf, path=/etc
 */
function extractStringFields(
  rawText: string,
  lowerText: string,
  matchedPhrase: string,
  fieldNames: string[],
  alreadyExtracted: Record<string, unknown>
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};

  // Remove the matched intent phrase and known extracted values from text
  let remaining = lowerText.replace(matchedPhrase, " ");
  for (const [, v] of Object.entries(alreadyExtracted)) {
    if (typeof v === "string") {
      remaining = remaining.replace(v, " ");
    }
  }
  remaining = remaining.replace(/\s+/g, " ").trim();

  // Strip filler words that aren't meaningful field values
  remaining = remaining.replace(/^(can you |could you |would you |please |hey |yo |just )+/i, "").trim();
  remaining = remaining.replace(/\b(please|for me|for errors|for issues)\b/gi, "").trim();
  remaining = remaining.replace(/\s+/g, " ").trim();

  // Check for quoted strings first
  const quoted = rawText.match(/["']([^"']+)["']/g);
  if (quoted) {
    for (let i = 0; i < Math.min(quoted.length, fieldNames.length); i++) {
      result[fieldNames[i]] = quoted[i].replace(/["']/g, "");
    }
    return result;
  }

  // For source/destination patterns (copy X to Y, move X to Y)
  if (fieldNames.includes("source") && fieldNames.includes("destination")) {
    const toMatch = remaining.match(/(.+?)\s+to\s+(.+)/);
    if (toMatch) {
      result.source = extractPathOrFilename(toMatch[1].trim());
      result.destination = extractPathOrFilename(toMatch[2].trim());
      return result;
    }
  }

  // For query/path patterns (grep X in Y, search X in Y, Y for X)
  if (fieldNames.includes("query") && fieldNames.includes("path")) {
    // "X in Y"
    const inMatch = remaining.match(/(.+?)\s+in\s+(.+)/);
    if (inMatch) {
      result.query = inMatch[1].trim().replace(/^(for|the)\s+/, "");
      result.path = extractPathOrFilename(inMatch[2].trim());
      return result;
    }
    // "Y for X" (path first, query second)
    const forMatch = remaining.match(/(.+?)\s+for\s+(.+)/);
    if (forMatch) {
      const left = forMatch[1].trim();
      const right = forMatch[2].trim();
      // If left looks like a path, it's path+query. Otherwise query+path.
      if (left.includes("/") || left.includes(".")) {
        result.path = extractPathOrFilename(left);
        result.query = right.replace(/^(the)\s+/, "");
      } else {
        result.query = left.replace(/^(the)\s+/, "");
        result.path = extractPathOrFilename(right);
      }
      return result;
    }
    // Split by path-like token: anything with / or . is path, rest is query
    const words = remaining.split(/\s+/).filter((w) => !isStopWord(w));
    const pathWord = words.find((w) => w.includes("/") || (w.includes(".") && w.length > 3));
    if (pathWord) {
      result.path = pathWord;
      result.query = words.filter((w) => w !== pathWord).join(" ") || undefined;
      return result;
    }
    if (words.length > 0) {
      result.query = words[0];
    }
    return result;
  }

  // For pattern/path patterns (find X in Y)
  if (fieldNames.includes("pattern") && fieldNames.includes("path")) {
    const inMatch = remaining.match(/(.+?)\s+in\s+(.+)/);
    if (inMatch) {
      result.pattern = extractPathOrFilename(inMatch[1].trim());
      result.path = extractPathOrFilename(inMatch[2].trim());
      return result;
    }
  }

  // For single target field (delete X, kill X)
  if (fieldNames.length === 1) {
    const words = remaining.split(/\s+/).filter((w) => !isStopWord(w));
    const pathLike = words.find((w) => w.includes("/") || w.includes("."));
    result[fieldNames[0]] = pathLike ?? words[0];
    return result;
  }

  // Generic: assign remaining words to fields in order
  const words = remaining.split(/\s+/).filter((w) => !isStopWord(w));
  for (let i = 0; i < Math.min(words.length, fieldNames.length); i++) {
    result[fieldNames[i]] = words[i];
  }

  return result;
}

function extractPathOrFilename(text: string): string {
  const cleaned = text.replace(/^(the|this|that|a|an|file|directory|dir|folder)\s+/gi, "").trim();
  const words = cleaned.split(/\s+/);
  // Find the most path-like word (Linux or Windows paths)
  const pathWord = words.find((w) =>
    w.includes("/") || w.includes("\\") || w.includes(".") || /^[A-Za-z]:/.test(w)
  );
  const result = pathWord ?? words[0] ?? cleaned;
  // Normalize Windows paths to Linux in WSL
  return normalizePath(result);
}

function isStopWord(word: string): boolean {
  return ["the", "a", "an", "this", "that", "on", "in", "at", "for", "from", "with", "of", "file", "files"].includes(word);
}

function matchIntent(
  text: string,
  intents: IntentDef[]
): { def: IntentDef; matchedPhrase: string } | null {
  let best: { def: IntentDef; matchedPhrase: string; length: number } | null = null;

  // Pass 1: exact substring match (fast path)
  for (const def of intents) {
    for (const phrase of def.synonyms) {
      if (text.includes(phrase)) {
        if (!best || phrase.length > best.length) {
          best = { def, matchedPhrase: phrase, length: phrase.length };
        }
      }
    }
  }

  if (best) return { def: best.def, matchedPhrase: best.matchedPhrase };

  // Pass 2: fuzzy/spell-corrected match — correct typos in user input
  // then retry matching. Only for single/double-word synonyms to avoid
  // false positives on long phrases.
  const corrected = spellCorrectText(text, intents);
  if (corrected !== text) {
    for (const def of intents) {
      for (const phrase of def.synonyms) {
        if (corrected.includes(phrase)) {
          if (!best || phrase.length > best.length) {
            best = { def, matchedPhrase: phrase, length: phrase.length };
          }
        }
      }
    }
  }

  return best ? { def: best.def, matchedPhrase: best.matchedPhrase } : null;
}

/**
 * Spell-correct text by replacing unknown words with the closest known synonym word.
 * Uses Levenshtein distance with a max edit distance of 2.
 */
function spellCorrectText(text: string, intents: IntentDef[]): string {
  // Build vocabulary from all synonyms
  const vocab = new Set<string>();
  for (const def of intents) {
    for (const phrase of def.synonyms) {
      for (const word of phrase.split(/\s+/)) {
        if (word.length >= 3) vocab.add(word);
      }
    }
  }

  const words = text.split(/\s+/);
  let changed = false;
  const correctedWords = words.map(word => {
    if (word.length < 3) return word;
    if (vocab.has(word)) return word; // already a known word

    // Find closest vocabulary word
    let bestWord = word;
    let bestDist = Infinity;
    const maxDist = word.length <= 4 ? 1 : 2;

    for (const candidate of vocab) {
      // Quick length check — edit distance can't be less than length difference
      if (Math.abs(candidate.length - word.length) > maxDist) continue;
      const dist = editDistance(word, candidate);
      if (dist <= maxDist && dist < bestDist) {
        bestDist = dist;
        bestWord = candidate;
      }
    }

    if (bestWord !== word) changed = true;
    return bestWord;
  });

  return changed ? correctedWords.join(" ") : text;
}

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function extractEnvironment(
  text: string,
  aliases: Record<string, string[]>
): EnvironmentName | undefined {
  for (const [canonical, aliasList] of Object.entries(aliases)) {
    for (const alias of aliasList) {
      const pattern = new RegExp(`\\b${escapeRegex(alias)}\\b`);
      if (pattern.test(text)) return canonical as EnvironmentName;
    }
  }
  return undefined;
}

function extractService(
  text: string,
  aliases: Record<string, string[]>,
  intentPhrase: string
): string | undefined {
  const cleaned = text.replace(intentPhrase, " ").trim();
  for (const [canonical, aliasList] of Object.entries(aliases)) {
    for (const alias of aliasList) {
      const pattern = new RegExp(`\\b${escapeRegex(alias)}\\b`);
      if (pattern.test(cleaned)) return canonical;
    }
  }
  for (const [canonical, aliasList] of Object.entries(aliases)) {
    for (const alias of aliasList) {
      const pattern = new RegExp(`\\b${escapeRegex(alias)}\\b`);
      if (pattern.test(text)) return canonical;
    }
  }
  return undefined;
}

function extractNumber(text: string): number | undefined {
  const match = text.match(/\b(\d+)\b/);
  return match ? Number(match[1]) : undefined;
}

function extractBranch(text: string): string | undefined {
  const match = text.match(/\b(main|master|develop|release\/[a-z0-9._-]+)\b/);
  return match?.[1];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
