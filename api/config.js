// 카카오 JS 키를 클라이언트에 안전하게 전달
module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    kakaoJsKey: process.env.KAKAO_JS_KEY || "",
  });
};
