// =============================================================================
// view_historical_routes.js — paste entire file into browser console
// Self-contained: routes embedded, no fetch needed.
// =============================================================================
(async function viewHistoricalRoutes() {
    const COLORS = {
        BEIGE:'#d2b48c', BLACK:'#1a1a1a', BLUE:'#2563eb', BROWN:'#8b4513',
        CORAL:'#ff7f50', GOLD:'#ffd700', GRAY:'#808080', GREEN:'#16a34a',
        MAROON:'#800000', ORANGE:'#f97316', PEACH:'#ffcba4', PINK:'#ec4899',
        PURPLE:'#9333ea', RED:'#dc2626', SILVER:'#c0c0c0', TEAL:'#14b8a6',
        WHITE:'#f5f5f5', YELLOW:'#facc15'
    };

    const ROUTES = {"BEIGE":["Goldberg, Huvi","Goldberg, Chaya Rochel","Teiler, Rochel","Teiler, Fraidy","Perlstein, Baila","Perlstein, Leah","Birnbaum, Yael","Birnbaum, Dina","Birnbaum, Zahava","Bleier, Mariam","Gluck, Chavi","Rudnicki, Miri","Cweiber, Leba","Tabak, Hudi","Wolf, Nechama","Silberstein, Sarah","Mizrahi, Rachel","Tabi, Miri","Aron, Avigayil","Shain, Chana","Tikhner, Naomi","Glassman, Minna","Schulgasser, Shoshana","Schulgasser, Goldie","Brisman, Devorah","Kahan, Sara","Nachumson, Atara","Lax, Batya","Gottlieb, Nechama","Stone, Chana","Scholar, Miri","Kaufman, Nechama","Kaufman, Rachel","Cooper, Chava","Cooper, Miriam","Frischman, Blimie","Feinstein, Miriam","Pechter, Gitti","Pechter, Sabi","Leshkowitz, Miri","Blumenfrucht, Shaindy","Blumenfrucht, Raizy","Fruchthandler, Tziri","Goldberger, Batsheva","Liebermann, Malka","Kornbluh, Bella"],"BLACK":["Lichtenfeld, Aviva","Lieberman, Esti","Becker, Batsheva","Becker, Faigy","Fagan, Zehava","Berger, Ita","Miller, Leah","Grossman, Fraidy","Ehrman, Adina","Back, Malka","Ehrman, Cipora","Jankelovits, Michal","Perlow, Sara","Sapezhansky, Sarah","Friedman, Rachel","Freeman, Rachel","Freeman, Miriam","Joseph, Racheli","Joseph, Sara","Kalisch, Chavi","Berger, Dina","Basch, Hudy","Fisher, Avigail","Obstfeld, Estee","Basch, Faigy","Basch, Sarah","Segal, Haddas","Rubelow, Goldie","Segal, Michal","Wolf, Adina","Berkowitz, Sara","Wolf, Talia","Kaplan, Fraidy","Hellman, Miri","Golding, Leah","Kranz, Shifra","Meyer, Breindy","Kanarek, Chava","Kanarek, Malka","Storch, Chani","Swerdloff, Riki","Possick, Devora","Perl, Chaya","Sonenblick, Miri","Sternbach, Batsheva","Sternbach, Chana","Nakdimen, Sari","Klugmann, Avigail"],"BLUE":["Antebi, Ruthie","Swiatycki, Kaila","Betesh, Sarah","Draiarsh, Chaya Sara","Cohen, Shani","Dinkels, Chashie","Betesh, Shoshana","Cohen, Hendy","Liberman, Miriam","Schorr, Leah","Brecher, Ella","Brecher, Atara","Neger, Chana","Levy, Nava","Hilman, Tzivya","Green, Etty","Yudkovsky, Rochelle","Yudkovsky, Chana","Rosenberg, Sari","Blumenkrantz, Kayla","Braun, Batsheva","Monoker, Frumi","Caplan, Leah","Ruzohorsky, Miri","Kutcher, Hadasa","Stern, Bracha","Kramer, Hudis","Anisfeld, Goldie","Berger, Miriam","Gewirtzman, Penina","Friedman, Shana","Frankel, Chedva","Frankel, Kaila","Jacobowitz, Miriam","Weiss, Chana","Jacobowitz, Perel","Israel, Esty","Israel, Gittel","Schubert, Yocheved","Taub, Racheli","Weinstein, Perel","Richt, Tzivi","Schepansky, Esther","Smoke, Nechama","Smoke, Tzivia","Soll, Yocheved","Diamond, Miriam","Feifer, Rosie","Klang, Brocha"],"BROWN":["Klein, Chana","Robinson, Leah","Bondy, Rachelli","Sommerfeld, Ayala","Schwartz, Rachel","Fogel, Yonina","Fogel, Hindy","Muschel, Shana","Wolf, Zeesy","Ungar, Aliza","Ungar, Esther","Greenebaum, Esty","Deutsch, Miriam","Hertz, Sari","Miller, Henny","Porgess, Adina","Orgel, Cheryl","Orgel, Dena","Orgel, Meira","Helmreich, Atara","Felder, Avigayil","Rutta, Tehilla","Rutta, Sarala","Felder, Chava","Orzel, Yehudis","Hoffman, Racheli","Gejerman, Perry","Munk, Chava","Silverstein, Esti","Flohr, Rikki","Silverstein, Riki","Finkel, Rachelli","Finkel, Aviva","Storch, Sarah","Gottlieb, Naomi","Heimowitz, Racheli","Heimowitz, Esther","Stein, Chani","Werner, Mindy","Schecter, Hadassa","Rabinowitz, Tzivia","Tropper, Hinda"],"CORAL":["Adler, Baila","Rex, Esther","Fried, Chaviva","Spira, Dina","Berkovicz, Ahuva","Leeder, Chaya Sara","Jaffe, Esti","Weinberg, Miriam","Pollak, Faigy","Fogel, Batsheva","Scheff, Yaela","Dorfman, Tzippy","Lew, Gitty","Dorfman, Esti","Levin, Miri","Friedman, Adina Sarah","Friedman, Rikki","Friedman, Yonina","Greenfield, Batsheva","Cherney, Abby","Balaban, Tehilla Yehudis","Ruvel, Rikki","Ruvel, Rena","Schiff, Charni","Schiff, Simi","Greenfield, Esther","Defreudiger, Esti","Greenfield, Yehudis","Schabes, Nechama","Pinkasovits, Vivi","Tauber, Avigail","Lerer, Rosie","Slatus, Yocheved","Slatus, Chana","Slatus, Avigayil","Shain, Adina","Shain, Ruchoma"],"GOLD":["Akerman, Leah","Jerusalem, Rochel","Blech, Aviva","Kenzer, Nechama","Strasberg, Hudis","Shapiro, Ahuva","Lapciuc, Leah","Friedman, Ahuva","Back, Devorah","Goldner, Chavy","Hoffman, Yitty","Friedman, Leah","Hoffman, Sarala","Rubin, Ahuva","Menchel, Simi","Shulman, Buna","Goldschmidt, Ruchoma","Katz, Adina","Goldstein, Peri","Youlus, Aliza","Ganz, Sima","Birnbaum, Toby","Friedman, Ahuva","Weinman, Rivka","Weinman, Yael","Berman, Ayala","Brenner, Esther","Newman, Estee","Landau, Leah","Verstandig, Tamara","Verstandig, Avital","Treitel, Chavie","Dembitzer, Ruby Dembitzer","Hoffman, Sophia","Hoffman, Talya","Friedman, Naomi","Ehrman, Meira","Boles, Esty","Ringel, Suri","Richter, Raizy","Marcus, Leah","Bar, Renee","Avshalom, Shira","Avshalom, Yael","Ellenbogen, Lea"],"GRAY":["Aaron, Chayala","Schuss, Miriam","Rudnicki, Mindy","Rudnicki, Chana","Massry, Chayala","Malin, Nechama Pessi","Kaisman, Esther","Kaisman, Shifra","Kaisman, Ahuva","Janowski, Simi","Malin, Rachel Frumit","Frankel, Rivky","Neuman, Sarah","Broyde, Sara","Broyde, Batsheva","Broyde, Etty","Yablonsky, Esti","Herz, Sara","Fried, Aviva","Herskowitz, Shaindel","David, Avigail","Abrams, Rochel","Abramson, Chaya","Broyde, Sara","Herskowitz, Leah","Stern, Rochel","Stern, Chana","Goldstein, Bracha","Epstein, Chelli","Levin, Leah","Stavrach, Esther","Stavrach, Chana","Siegfried, Bella","Siegfried, Chani","Schwarz, Leah","Schwarz, Yehudis","Goldstein, Esther","Moskovits, Sarala","Moskovits, Toby","Meisels, Hennie","Goldstein, Batsheva","Goldstein, Aliza","Waldman, Nechama","Hoffberg, Elisheva","Waldman, Racheli","Rosenberg, Rivky","Miller, Avigail","Schwartz, Ahuva","Schwartz, Miriam","Sobel, Tzirel","Rosenberg, Breidny"],"GREEN":["Feldman, Bassy","Gobioff, Rikki","Lopiansky, Rikki","Lopiansky, Aliza","Lopiansky, Tehilla","Siegfried, Dina","Beck, Tamar","Schlesinger, Daniella","Hiley, Ariella","Rosenberg, Shana","Enock, Elka","Ackerman, Chaya","Ackerman, Adina","Weinberg, Esther","Pilchick, Goldy","Itzkowitz, Sari","Friedman, Ayala","Deutsch, Gitty Deutsch","Silver, Abby","Silver, Hadassa","Kirzner, Vichna","Kirzner, Rochel","Landsberg, Devora","Weinberger, Chana","Breiner, Tzivya","Fried, Batsheva","Witty, Sarah Gila"],"MAROON":["Reichman, Aviva","Monoker, Avigail","Sorotzkin, Esther","Sorotzkin, Rochel","Shapiro, Zahava","Muller, Adina","Feder, Miri","Muller, Yael","Hainig, Daniella","Birnbaum, Tamara","Krasner, Yael","Krasner, Atara","Lieberman, Fraydee","Lieberman, Leah","Aberbach, Lani","Aberbach, Leah","Amoyelle, Esther","Berger, Avigayil","Ganz, Bryna","Blaustein, Tehilla","Ganz, Rachelli","Gold, Atara","Green, Leah","Green, Chana","Bensoussan, Elana","Gold, Leah","Silver, Meira","Fleischman, Rena","Wilner, Miri","Tress, Miri","Lichtman, Avigail","Lichtman, Tamary","Tress, Leah","Schlachet, Kayla","Gutman, Mindy","Gutman, Chava","Maidi, Elana","Maidi, Malka","Isaacson, Esther","Sahar, Leah","Furer, Esther","Gobioff, Ahuva","Mayer, Ariella","Furer, Goldy","Lowenstein, Sarah Meirav","Lowenstein, Yaeli","Lowenstein, Lily","Sevy, Rachel Leah"],"ORANGE":["Marcus, Adina","Samson, Rochel","Linsky, Chani","Marcus, Hadassa","Marcus, Nechama","Samson, Rivka","Breiner, Rena","Friedman, Miri","Plotsker, Chayala","Sharaby, Miri","Benisti, Ahuva","Morgenstern, Mindy","Dickstein, Ahuva","Gruen, Ettie","Gruen, Bassie","Relis, Devora","Relis, Rachelli","Neustadt, Miriam","Salomon, Aliza","Salomon, Lele","Becker, Meira","Grunhut, Yocheved","Schwartz, Lele","Smilow, Leah","Goldberger, Leah","Biegeleisen, Sarala","Hanover, Adina","Biegeleisen, Rachelli","Berger, Tova","Brodt, Chanala","Richter, Rivka","Gut, Aliza","Gold, Bracha","Stauber, Nechama","Stauber, Miriam","Maymon, Michal","Fried, Breindy","Kalish, Perli","Sternheim, Simi","Vorhand, Golda","Brachfeld, Riki","Kraushar, Devoiry","Einhorn, Chassida","Melcer, Nechama","Gorelick, Dassi","Katz, Yitty","Greenberg, Chavi","Greenberg, Tzipora","Perlow, Leah","Katz, Miriam"],"PEACH":["Spero, Brocha","Scott, Fraidy","Rothstein, Hadassah","Bak, Batsheva","Natan, Ayala","Hirsch, Peri","Amon, Gene","Jeremias, Riki","Polinsky, Tehilla","Lewenstein, Mati","May, Simi","Darabaner, Yehudis","Stern, Frumi","Moskowitz, Sari","Stern, Avigail","Shafran, Adina","Bernstein, Hadassa","Felsinger, Sari","Sturman, Lele","Sturman, Leeba","Gellis, Devorah","Lowy, Gitty","Hirsch, Chaya Tzipora Hirsch","Hirsch, Ita","Hirsch, Miriam","Hildeshaim, Esti","Back, Basya","Back, Layla","Hildeshaim, Chani","Herber, Yocheved","Heller, Baila","Deutsch, Mushky","Dvorkes, Hadas","Dvorkes, Mimi","Goldberg, Leah","Czermak, Rikki","Zeitman, Tamar","Zaks, Adina","Grunberger, Racheli","Mendlowitz, Adina","Mendlowitz, Yael","Klein, Sorala","Escava, Rachel","Greenwald, Rachelli","Levy, Rivkah","Pomerantz, Tzipora","Goldman, Riki"],"PINK":["Alter, Tzipora","Tabak, Rivka","Septon, Penina","Landau, Leah","Landau, Malka","Garfinkel, Sarah","Fox, Hadas","Landau, Devora","Berkowitz, Rachel","Yarmush, Adina","Taplin, Yehudis","Sternstein, Saraliza","Sternstein, Avigail","Singer, Tzippora","Goldstein, Esti","Lieberman, Sori","Lieberman, Leah","Barer, Tzipora","Stern, Fraydee","Steinberg, Tirtza","Munk, Michal","Levin, Rachelli","Klein, Adina","Eisen, Dassi","Lesser, Tova","Engel, Sarah","Waidenbaum, Rochel","Waidenbaum, Rochel","Diamant, Raizy","Brody, Michal","Glass, Shoshana","Glass, Avigail","Sprecher, Rikki","Serebrowski, Rikki","Schmuckler, Malky","Grama, Esther Yehudis","Goldenberg, Yael","Grama, Adina","Brody, Ahuva","Brody, Chana","Laniado, Rina","Diamant, Shaindy","Grama, Leeba","Hirschel, Chaya","Lichtman, Miri","Lichtman, Aliza","Goldburd, Bassi","Goldburd, Riki","Shiman, Michal","Shiman, Avigail","Klein, Leah","Klein, Bayla","Kaufman, Rachel","Wolmark, Miriam"],"PURPLE":["Pick, Nechama","Moskowitz, Mindy","Weingarten, Esti","Waxman, Rivka","Klein, Etti","Yanes, Esther Shaindel","Wesel, Miriam","Barash, Zisi","Schonblum, Sarala","Friedman, Avigail","Gottlieb, Chaya","Twersky, Shiffy","Paler, Dina","Orbach, Ahuva","Levin, Sari","Azoolay, Chaya","Azoolay, Miriam","Brecher, Leba","Elbogen, Leah","Iwaniski, Bracha","Svarc, Nechama","Steinmetz, Shira","Rothenberg, Raizy","Rotenberg, Deena","Rotenberg, Shayna","Rothenberg, Shoshana","Loketch, Tzipora","Rubelow, Ahuva","Barrish, Chaya Sara","Grossman, Rivky","Lutin, Dassy","Perlstein, Mindy","Silver, Leah","Schecter, Rachelle","Silver, Michal","Fuchs, Atara","Rothschild, Shevy","Josephs, Batsehva","Kleinhendler, Adina","Statfeld, Leora","Bender, Tehilla","Miller, Adina","Goldberger, Batsheva","Wulliger, Miriam","Goldberger, Yocheved","Neustadt, Adina","Goldring, Gitty"],"RED":["Kugler, Sara","Whitehouse, Charna","Kugler, Tzipora","Whitehouse, Devorah","Whitehouse, Etty","Kaufman, Bracha","Kaufman, Devora","Jakobovits, Chava","Shenkolevsky, Lea","Schorr, Hindy","Schorr, Fraidy","Grossman, Rochel","Feldhamer, Faigy","Reich, Dassi","Raber, Chayala","Newhouse, Raizy","Feldhamer, Tobi","Reich, Malki","Snow, Miriam","Winkler, Esti","Greenspan, Zehava","Friedman, Rikki","Asseraf, Miriam","Gemal, Rochel","Fruchthandler, Rochel","Gellis, Rachelli","Becker, Devora","Weinstein, Tzipora","Weinstein, Temi","Steinharter, Simi","Steinharter, Yocheved","Steinharter, Bracha","Fuerst, Yehudis","Abramson, Shana","Sabo, Hudis","Gellis, Ruti","Gellis, Sari","Gellis, Hadassa","Ornstein, Yitty","Griver, Esti","Lapides, Mindy","Hirsch, Sara","Kahan, Goldie","Hirsch, Breindy","Saks, Chama"],"SILVER":["Zussman, Chani","Gottesman, Chaya","Lustiger, Chavi","Metzger, Ruti","Shulman, Sara Rina","Vogel, Peri","Bulman, Raizy","Vogel, Malka","Tress, Henny","Neumann, Yehudis","Teicher, Tziporah","Herskovits, Sophie","Czermak, Serri","Dorfman, Sara","Compton, Sori","Compton, Ahuva","Reiss, Chaya","Hertz, Gitty","Drillick, Malky","Jacobson, Henny","Kibel, Hindy","Katz, Adina","Levitan, Ahuva","Abramczyk, Shaindy","Oelbaum, Rivky","Wahl, Deena","Katz, Leeba","Alon, Rochella","Cohen, Tziri","Glenn, Ahuva","Thau, Rivky","Manies, Rikki","Manies, Rachelli","Freund, Brochie","Fischer, Henny","Neuwirth, Bracha","Homnick, Tehila","Perlow, Chaya Esther","Fischer, Shaindy","Gruber, Adina","Katz, Hudis","Dwek, Rachel","Cohen, Elisheva","Grama, Aliza","Dwek, Sarah","Smith, Shana","Yaroslawitz, Chaya Bracha","Yaroslawitz, Esty","Swerdloff, Sarah","Goldman, Ayala","Fried, Sori"],"TEAL":["Kornbluth, Esther","Dunoff, Penina","Dunoff, Malka","Marvet, Racheli","Marvet, Aliza","Schwartz, Rachelli","Schwartz, Leah","Hirsch, Esther","Kornbluh, Sari","Dimarsky, Chavi","Stern, Leah","Katz, Yehudis","Neuhaus, Nechama","Neuhaus, Chavi","Marmorstein, Sima","Levy, Miriam","Rabinowitz, Bracha","Rabinowitz, Racheli","Yormark, Shoshana","Iann, Chavi","Rabinowitz, Sara","Iann, Esty","Horwitz, Hadassah","Belsky, Yael","Horwitz, Ayala","Horwitz, Rena","Feifer, Eliana","Green, Michal","Young, Estee","Green, Adina","Hecht, Goldie","Bornstein, Sara","Gold, Esther","Cohen, Shaindy","Cohen, Dassi","Cohen, Rikki","Bornstein, Mindy","Tomor, Charna","Tomor, Rosie","Weitman, Adina","Weitman, Rachel","Vinitsky, Tziporah","Staum, Chayala","Klein, Shira","Binder, Chana","Birnbaum, Naomi","Klein, Penina","Lowy, Tziporah","Feiner, Rachel","Levin, Riikki","Birnbaum, Shani","Ben-jacob, Rachel"],"WHITE":["Rosenfeld, Russi","Mendlowitz, Perri","Friedman, Malky","Friedman, Sari","Kahan, Rivky","Herzog, Faigy","Gross, Sorala","Kahan, Shifra","Anemer, Perri","Babad, Dina","Slomovits, Chavie","Treitel, Toby","Treitel, Baila","Gobioff, Adina","Gobioff, Aliza","Novoseller, Adina","Bruck, Ahuva","Davis, Tehilla","Weiss, Yocheved","Shapiro, Batsheva","Breatross, Ayala","Bender, Bassie","Schorr, Bracha","Semah, Debra","Kreitman, Adina","Kreitman, Sara","Brull, Rochel","Brull, Nechama","Greenebaum, Tzipori","Schmool, Meryl","Safdieh, Brenda","Safdieh, Mozelle","Schwab, Leeba","Weiss, Miriam","Kleinman, Rena","Fishman, Chayala","Gruenebaum, Tziporah","Pritzker , Rachelli","Bendkowski, Rikki","Bendkowski, Batsheva","Herzberg, Rivka Nechama","Verschleisser, Kayla","Mendlowitz, Sarala","Lerner, Sary","Bernstein, Miriam Baila"],"YELLOW":["Schon, Rivky","Luwish, Ahuva","Stern, Shayna","Simha, Mindy","Moore, Racheli","Moore, Rikki","Chorney, Chana Tehila","Perl, Shaindy","Forst, Aliza","Forst, Adina","Salomon, Shaina","Oelbaum, Rosie","Oelbaum, Rutti","Maybloom, Zehava","Ritterman, Aliza","Pollack, Gitti","Greenberg, Suri","Baldinger, Esti","Baldinger, Henny","Brander, Gitty","Brander, Tova","Greenberg, Leah","Hettleman, Ruti","Tokayer, Kayla","Schoenfeld, Chani","Schlesinger, Sarah","Brisman, Leah","Brisman, Chaya","Brisman, Gitty","Drebin, Ahuva","Ganz, Bryna","Ganz, Chaya","Goldberg, Fraidy","Kikin, Racheli","Sokol, Atara","Zuker, Esty","Waldman, Frady","Phillip, Esti","Rosenfeld, Sarah","Cohen, Malka","Rosenfeld, Ahuva","Danzig, Sima Leah"]};

    function normalize(name) { return name.toLowerCase().replace(/[^a-z]/g, ''); }

    // Build name → coords from all available sources
    const coords = {};
    function addCamper(name, lat, lng) {
        if (!name || !lat || !lng) return;
        coords[normalize(name)] = { lat, lng, displayName: name };
    }

    // Source 1: saved routes (has stops with members)
    const saved = window.CampistryGo?._getSavedRoutes?.();
    console.log('[Historical] saved routes:', saved);
    function walk(node) {
        if (!node) return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (typeof node !== 'object') return;
        // Stop with members
        if (node.lat && node.lng && Array.isArray(node.members)) {
            node.members.forEach(m => addCamper(m.name || m.camperName || m, node.lat, node.lng));
        }
        // Stop with single camper
        if (node.lat && node.lng && (node.name || node.camperName)) {
            addCamper(node.name || node.camperName, node.lat, node.lng);
        }
        if (node.stops) walk(node.stops);
        if (node.buses) walk(node.buses);
        if (node.shifts) walk(node.shifts);
        if (node.routes) walk(node.routes);
        if (node.campers) walk(node.campers);
    }
    walk(saved);
    console.log('[Historical] Coords from saved routes:', Object.keys(coords).length);

    // Source 2: Try map markers if too few
    if (Object.keys(coords).length < 100) {
        try {
            const map = window.CampistryGo?._getMap?.();
            if (map) {
                map.eachLayer(layer => {
                    if (layer.getLatLng && layer.getPopup) {
                        const ll = layer.getLatLng();
                        const pop = layer.getPopup();
                        const txt = pop?.getContent?.() || '';
                        const nameMatch = String(txt).match(/<strong>([^<]+)<\/strong>/);
                        if (nameMatch) addCamper(nameMatch[1].trim(), ll.lat, ll.lng);
                    }
                });
                console.log('[Historical] After map scan:', Object.keys(coords).length);
            }
        } catch (e) { console.warn('[Historical] map scan failed:', e); }
    }

    if (Object.keys(coords).length === 0) {
        alert('No camper coordinates found. Please generate routes first, then run this script again.');
        return;
    }

    // Match historical names
    const matched = {};
    let totalMatched = 0, totalMissing = 0;
    const missing = {};
    for (const [color, names] of Object.entries(ROUTES)) {
        matched[color] = [];
        missing[color] = [];
        for (const lf of names) {
            const parts = lf.split(',').map(s => s.trim());
            const last = parts[0] || '', first = parts[1] || '';
            const try1 = normalize(first + last);
            const try2 = normalize(last + first);
            const c = coords[try1] || coords[try2];
            if (c) { matched[color].push({ name: lf, lat: c.lat, lng: c.lng }); totalMatched++; }
            else { missing[color].push(lf); totalMissing++; }
        }
    }
    console.log('[Historical] Matched ' + totalMatched + ' / ' + (totalMatched + totalMissing));
    console.log('[Historical] Missing:', missing);

    if (totalMatched === 0) {
        alert('Matched 0 names. Check console — your roster names may use a different format.');
        return;
    }

    if (!window.L) { alert('Leaflet not loaded in this page. Open the map tab in the app first.'); return; }
    const L = window.L;

    // Remove any existing overlay
    document.getElementById('historical-overlay')?.remove();

    // Build fullscreen overlay in the current page (uses already-loaded Leaflet)
    const overlay = document.createElement('div');
    overlay.id = 'historical-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;display:flex;font-family:system-ui,sans-serif';
    overlay.innerHTML =
        '<div style="width:280px;background:#f9fafb;border-right:1px solid #e5e7eb;overflow-y:auto;padding:12px;box-sizing:border-box">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2 style="margin:0;font-size:16px">Last Year Routes</h2><button id="hist-close" style="padding:4px 10px;cursor:pointer">✕ Close</button></div>' +
            '<div><button id="hist-all" style="padding:4px 10px;cursor:pointer;margin-right:4px">All</button><button id="hist-none" style="padding:4px 10px;cursor:pointer">None</button></div>' +
            '<div id="hist-list" style="margin-top:8px"></div>' +
        '</div>' +
        '<div id="hist-map" style="flex:1"></div>';
    document.body.appendChild(overlay);

    const styleEl = document.createElement('style');
    styleEl.textContent = '.hist-route{display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer;border-radius:4px;margin-bottom:2px;font-size:13px}.hist-route:hover{background:#e5e7eb}.hist-route.off{opacity:.3}.hist-dot{width:14px;height:14px;border-radius:50%;border:1px solid #555;flex-shrink:0}.hist-count{margin-left:auto;color:#666;font-size:12px}';
    document.head.appendChild(styleEl);

    const map = L.map(document.getElementById('hist-map')).setView([40.08, -74.22], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

    const layers = {};
    const visible = {};
    const allBounds = [];
    for (const color of Object.keys(matched)) {
        const lg = L.layerGroup();
        matched[color].forEach(c => {
            const m = L.circleMarker([c.lat, c.lng], {
                radius: 5, color: '#222', weight: 1,
                fillColor: COLORS[color], fillOpacity: 0.85
            });
            m.bindPopup('<b>' + color + '</b><br>' + c.name);
            m.addTo(lg);
            allBounds.push([c.lat, c.lng]);
        });
        layers[color] = lg;
        visible[color] = true;
        lg.addTo(map);
    }
    if (allBounds.length) map.fitBounds(allBounds, { padding: [20, 20] });

    const list = document.getElementById('hist-list');
    for (const color of Object.keys(matched)) {
        const div = document.createElement('div');
        div.className = 'hist-route';
        div.innerHTML = '<span class="hist-dot" style="background:' + COLORS[color] + '"></span><span>' + color + '</span><span class="hist-count">' + matched[color].length + '</span>';
        div.addEventListener('click', () => toggle(color, div));
        list.appendChild(div);
    }
    function toggle(color, div) {
        visible[color] = !visible[color];
        if (visible[color]) { layers[color].addTo(map); div.classList.remove('off'); }
        else { map.removeLayer(layers[color]); div.classList.add('off'); }
    }
    document.getElementById('hist-all').onclick = () => {
        document.querySelectorAll('.hist-route').forEach((div, i) => {
            const c = Object.keys(matched)[i];
            if (!visible[c]) toggle(c, div);
        });
    };
    document.getElementById('hist-none').onclick = () => {
        document.querySelectorAll('.hist-route').forEach((div, i) => {
            const c = Object.keys(matched)[i];
            if (visible[c]) toggle(c, div);
        });
    };
    document.getElementById('hist-close').onclick = () => overlay.remove();

    setTimeout(() => map.invalidateSize(), 100);
    console.log('[Historical] Overlay rendered with ' + totalMatched + ' campers across ' + Object.keys(matched).length + ' routes.');
})();
