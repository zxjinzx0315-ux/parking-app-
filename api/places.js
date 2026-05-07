// 카카오 로컬 API 프록시 (REST 키 서버에서 숨김)
const https = require("https");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=60");

  const restKey = process.env.KAKAO_REST_KEY || "";
  if (!restKey) {
    res.status(500).json({ error: "REST key not configured" });
    return;
  }

  const { mode, lat, lon, query } = req.query;
  const radius = 800;
  let apiUrl;

  if (mode === "food") {
    apiUrl = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query || "맛집")}&x=${lon}&y=${lat}&radius=${radius}&size=10&sort=accuracy`;
  } else if (mode === "fuel") {
    apiUrl = `https://dapi.kakao.com/v2/local/search/category.json?category_group_code=OL7&x=${lon}&y=${lat}&radius=${radius}&size=10&sort=distance`;
  } else if (mode === "geo") {
    apiUrl = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query || "")}&size=1`;
  } else {
    res.status(400).json({ error: "invalid mode" });
    return;
  }

  const options = {
    hostname: "dapi.kakao.com",
    path: apiUrl.replace("https://dapi.kakao.com", ""),
    method: "GET",
    headers: { Authorization: `KakaoAK ${restKey}` },
  };

  const proxy = https.request(options, (apiRes) => {
    let data = "";
    apiRes.on("data", (chunk) => (data += chunk));
    apiRes.on("end", () => {
      res.status(apiRes.statusCode).setHeader("Content-Type", "application/json").end(data);
    });
  });

  proxy.on("error", (e) => res.status(500).json({ error: e.message }));
  proxy.end();
};
