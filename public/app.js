// Guest page behaviour: load the weather strip and send the message.

// Barcelona, next 7 days, max temperature and chance of rain.
const WEATHER_URL =
  "https://api.open-meteo.com/v1/forecast?latitude=41.39&longitude=2.17&daily=temperature_2m_max,precipitation_probability_max&timezone=Europe%2FMadrid&forecast_days=7";

// Turn an ISO date (YYYY-MM-DD) into a short label like "Mon 10 Nov".
function formatDate(isoDate) {
  const date = new Date(isoDate + "T00:00:00");
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

async function loadWeather() {
  const strip = document.getElementById("weather-strip");

  try {
    const response = await fetch(WEATHER_URL);
    if (!response.ok) throw new Error("Weather request failed");

    const data = await response.json();
    const days = data.daily.time;
    const maxTemps = data.daily.temperature_2m_max;
    const rainChance = data.daily.precipitation_probability_max;

    strip.innerHTML = "";
    days.forEach((day, i) => {
      const el = document.createElement("div");
      el.className = "weather-day";
      el.innerHTML = `
        <div class="date">${formatDate(day)}</div>
        <div class="temp">${Math.round(maxTemps[i])}&deg;C</div>
        <div class="rain">Rain ${rainChance[i]}%</div>
      `;
      strip.appendChild(el);
    });
  } catch {
    strip.innerHTML = '<p class="weather-error">The weather is not available right now.</p>';
  }
}

async function sendMessage(event) {
  event.preventDefault();

  const form = event.target;
  const button = form.querySelector(".send");
  const replyBox = document.getElementById("reply");

  const payload = {
    name: form.name.value.trim(),
    email: form.email.value.trim(),
    message: form.message.value.trim(),
  };

  // The three fields are required.
  if (!payload.name || !payload.email || !payload.message) {
    replyBox.hidden = false;
    replyBox.className = "reply error";
    replyBox.textContent = "Please fill in your name, email and message.";
    return;
  }

  button.disabled = true;
  replyBox.hidden = false;
  replyBox.className = "reply";
  replyBox.textContent = "Sending your message.";

  try {
    const response = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      replyBox.className = "reply error";
      replyBox.textContent = data.error || "Something went wrong. Please try again.";
      return;
    }

    replyBox.className = "reply";
    replyBox.textContent = data.reply;
  } catch {
    replyBox.className = "reply error";
    replyBox.textContent = "Something went wrong. Please try again.";
  } finally {
    button.disabled = false;
  }
}

document.getElementById("message-form").addEventListener("submit", sendMessage);
loadWeather();
