// 클라이언트에 필요한 서버 환경변수 전달
module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    kakaoJsKey:   process.env.KAKAO_JS_KEY    || "",
    ggParkingKey: process.env.GG_PARKING_KEY  || "",
    kakaoRestKey: process.env.KAKAO_REST_KEY  || "",
  });
};
