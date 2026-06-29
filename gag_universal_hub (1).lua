
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Lighting = game:GetService("Lighting")
local TweenService = game:GetService("TweenService")
local UserInputService = game:GetService("UserInputService")
local Workspace = game:GetService("Workspace")

local Player = Players.LocalPlayer
local Character = Player.Character or Player.CharacterAdded:Wait()
local Humanoid = Character:WaitForChild("Humanoid")
local HumanoidRootPart = Character:WaitForChild("HumanoidRootPart")

repeat task.wait() until game:IsLoaded()
repeat task.wait() until Player:FindFirstChild("PlayerGui")

-- Remote Discovery
local Remotes = {}
local function DiscoverRemotes()
    local function ScanFolder(folder)
        for _, obj in pairs(folder:GetDescendants()) do
            if obj:IsA("RemoteEvent") or obj:IsA("RemoteFunction") then
                Remotes[obj.Name] = obj
            end
        end
    end
    local locations = {
        ReplicatedStorage:FindFirstChild("Remotes"),
        ReplicatedStorage:FindFirstChild("RemoteEvents"),
        ReplicatedStorage:FindFirstChild("Network")
    }
    for _, loc in pairs(locations) do if loc then ScanFolder(loc) end end
    if not next(Remotes) then ScanFolder(ReplicatedStorage) end
end
DiscoverRemotes()

local function SafeCall(remoteName, ...)
    local remote = Remotes[remoteName]
    if not remote then
        local alternates = {
            PlantSeed = {"PlantSeed","Plant","PlaceSeed","SowSeed"},
            HarvestPlant = {"HarvestPlant","Harvest","CollectPlant","PickPlant"},
            BuySeed = {"BuySeed","PurchaseSeed","BuyItem"},
            BuyGear = {"BuyGear","PurchaseGear","BuyTool"},
            SendMail = {"SendMail","SendGift","MailItem","SendItem"},
            GetShopData = {"GetShopData","ShopData","GetShop","GetStore"},
            GetWeatherData = {"GetWeatherData","WeatherData","GetWeather"},
            GetEventData = {"GetEventData","EventData","GetEvent"}
        }
        if alternates[remoteName] then
            for _, alt in pairs(alternates[remoteName]) do
                if Remotes[alt] then remote = Remotes[alt] break end
            end
        end
    end
    if remote then
        local success, result = pcall(function(...)
            if remote:IsA("RemoteEvent") then remote:FireServer(...) return true
            else return remote:InvokeServer(...) end
        end, ...)
        return success, result
    end
    return false, nil
end

-- OrionLib
local OrionLib = loadstring(game:HttpGet('https://raw.githubusercontent.com/shlexware/Orion/main/source'))()
local Window = OrionLib:MakeWindow({
    Name = "🌱 Grow a Garden 2 - Premium Hub",
    HidePremium = false, SaveConfig = true,
    ConfigFolder = "GAG2_Premium_v2",
    IntroEnabled = true, IntroText = "Grow a Garden 2",
    IntroIcon = "rbxassetid://4483345998"
})

-- State
local State = {
    AutoPlantSeed = false, AutoPlantAllSeeds = false,
    SelectedSeed = "", SprinklerRadius = 5, UseSprinklerRadius = true,
    PlantDelay = 0.3, MaxPlantsPerCycle = 50,
    AutoSendGear = false, SelectedSendGear = "", SendTarget = "",
    SendInterval = 60, SendAmount = 1,
    SeedStockPredictions = false, SeedPredictionNotifications = false,
    IgnoredSeeds = {}, AutoBuySeeds = false, SeedBuyBudget = 10000,
    GearStockPredictions = false, GearPredictionNotifications = false,
    IgnoredGear = {}, AutoBuyGear = false, GearBuyBudget = 10000,
    EventWeatherPredictions = false, ShowWeatherHUD = false,
    FullBright = false, InfiniteZoomOut = false, NoClip = false,
    WalkSpeed = 16, JumpPower = 50,
    IsRunning = true, LastStockUpdate = 0,
    WeatherHistory = {}, StockHistory = {Seeds = {}, Gear = {}},
    OriginalLighting = nil, OriginalZoom = nil
}

-- Utils
local Utils = {}
function Utils.GetPlot()
    local plots = Workspace:FindFirstChild("Plots")
    if plots then
        local plot = plots:FindFirstChild(Player.Name)
        if plot then return plot end
    end
    for _, obj in pairs(Workspace:GetDescendants()) do
        if obj:IsA("Model") then
            local ownerVal = obj:FindFirstChild("Owner")
            if ownerVal and ownerVal:IsA("ObjectValue") and ownerVal.Value == Player then return obj end
            if obj:GetAttribute("Owner") == Player.Name or obj:GetAttribute("PlotOwner") == Player.Name then return obj end
        end
    end
    return nil
end

function Utils.GetSprinklers()
    local plot = Utils.GetPlot()
    local sprinklers = {}
    if not plot then return sprinklers end
    for _, obj in pairs(plot:GetDescendants()) do
        local name = obj.Name:lower()
        if name:find("sprinkler") or name:find("water") then table.insert(sprinklers, obj) end
        if obj:GetAttribute("IsSprinkler") or obj:GetAttribute("Type") == "Sprinkler" then table.insert(sprinklers, obj) end
    end
    return sprinklers
end

function Utils.GetSprinklerRadius(sprinkler)
    if not State.UseSprinklerRadius then return State.SprinklerRadius end
    local radius = 5
    if sprinkler:GetAttribute("Radius") then radius = sprinkler:GetAttribute("Radius")
    elseif sprinkler:GetAttribute("Range") then radius = sprinkler:GetAttribute("Range")
    elseif sprinkler:GetAttribute("Coverage") then radius = sprinkler:GetAttribute("Coverage") end
    local config = sprinkler:FindFirstChild("Configuration")
    if config then
        local rv = config:FindFirstChild("Radius") or config:FindFirstChild("Range")
        if rv and (rv:IsA("NumberValue") or rv:IsA("IntValue")) then radius = rv.Value end
    end
    local upgrades = sprinkler:FindFirstChild("Upgrades")
    if upgrades then
        for _, up in pairs(upgrades:GetChildren()) do
            local un = up.Name:lower()
            if un:find("radius") or un:find("range") then
                if up:IsA("NumberValue") or up:IsA("IntValue") then radius = radius + up.Value end
            end
        end
    end
    local mult = sprinkler:GetAttribute("RadiusMultiplier") or 1
    return math.max(1, radius * mult)
end

function Utils.GetInventoryItems()
    local seeds, gear, seen = {}, {}, {}
    local function scan(c)
        if not c then return end
        for _, item in pairs(c:GetChildren()) do
            if item:IsA("Tool") or item:IsA("Model") then
                local n = item.Name
                if seen[n] then continue end
                seen[n] = true
                local ln = n:lower()
                if ln:find("seed") or item:GetAttribute("IsSeed") or item:GetAttribute("ItemType") == "Seed" then
                    table.insert(seeds, n)
                else table.insert(gear, n) end
            end
        end
    end
    scan(Player:FindFirstChild("Backpack"))
    scan(Player:FindFirstChild("StarterGear"))
    if Character then scan(Character) end
    return seeds, gear
end

function Utils.GetValidPlantPositions(centerPos, radius, plot)
    local positions = {}
    if not plot then return positions end
    local pc = plot:GetPivot()
    local ps = plot:GetExtentsSize()
    local step, gridRange = 3, math.floor(radius / step)
    for x = -gridRange, gridRange do
        for z = -gridRange, gridRange do
            local pos = centerPos + Vector3.new(x * step, 0, z * step)
            local dist = (Vector3.new(pos.X, centerPos.Y, pos.Z) - Vector3.new(centerPos.X, centerPos.Y, centerPos.Z)).Magnitude
            if dist <= radius then
                local rp = pos - pc.Position
                if math.abs(rp.X) <= ps.X/2 - 1 and math.abs(rp.Z) <= ps.Z/2 - 1 then
                    local isEmpty = true
                    for _, ex in pairs(plot:GetDescendants()) do
                        if ex:IsA("Model") and (ex:FindFirstChild("Seed") or ex:FindFirstChild("Plant") or ex:GetAttribute("IsPlant")) then
                            local ep = ex:GetPivot().Position
                            if (Vector3.new(ep.X, pos.Y, ep.Z) - Vector3.new(pos.X, pos.Y, pos.Z)).Magnitude < 2.5 then
                                isEmpty = false break
                            end
                        end
                    end
                    if isEmpty then table.insert(positions, pos) end
                end
            end
        end
    end
    return positions
end

function Utils.GetShopData(category)
    local success, result = SafeCall("GetShopData", category)
    if success and result then return result end
    return {}
end

function Utils.GetMoney()
    local sources = {
        Player:FindFirstChild("leaderstats") and Player.leaderstats:FindFirstChild("Money"),
        Player:FindFirstChild("leaderstats") and Player.leaderstats:FindFirstChild("Sheckles"),
        Player:FindFirstChild("Money"), Player:FindFirstChild("Sheckles"), Player:FindFirstChild("Cash")
    }
    for _, s in pairs(sources) do
        if s and (s:IsA("IntValue") or s:IsA("NumberValue")) then return tonumber(s.Value) or 0 end
    end
    return 999999
end

-- Predictor
local Predictor = {}
function Predictor.AnalyzeHistory(history)
    if #history < 2 then
        return {probability = 50, estimatedTime = "Gathering data...", confidence = "Low", trend = "Unknown", nextRestock = "Unknown"}
    end
    local intervals, lastOut = {}, nil
    for _, entry in ipairs(history) do
        if not entry.InStock then lastOut = entry.Timestamp
        elseif lastOut and entry.InStock then
            table.insert(intervals, entry.Timestamp - lastOut)
            lastOut = nil
        end
    end
    if #intervals == 0 then
        local alwaysInStock = true
        for _, e in ipairs(history) do if not e.InStock then alwaysInStock = false break end end
        if alwaysInStock then return {probability = 100, estimatedTime = "Always in stock", confidence = "High", trend = "Stable", nextRestock = "Now"} end
        return {probability = 50, estimatedTime = "Analyzing...", confidence = "Low", trend = "Unknown", nextRestock = "Unknown"}
    end
    local totalInt = 0
    for _, i in pairs(intervals) do totalInt = totalInt + i end
    local avgInt = totalInt / #intervals
    local trend = "Stable"
    if #intervals >= 3 then
        local diff = intervals[#intervals] - intervals[#intervals-1]
        if math.abs(diff) > avgInt * 0.1 then trend = diff < 0 and "Faster" or "Slower" end
    end
    local lastEntry = history[#history]
    local timeSince = tick() - lastEntry.Timestamp
    local prob = math.min(95, math.max(5, (timeSince / avgInt) * 100))
    if lastEntry.InStock then prob = 100 end
    local estSec = math.max(0, avgInt - timeSince)
    local estTime
    if estSec == 0 then estTime = "Now"
    elseif estSec < 60 then estTime = string.format("%ds", math.floor(estSec))
    elseif estSec < 3600 then estTime = string.format("%dm", math.floor(estSec / 60))
    else estTime = string.format("%.1fh", estSec / 3600) end
    local nextRestock = "Unknown"
    if not lastEntry.InStock then
        local tu = math.max(0, avgInt - timeSince)
        if tu < 60 then nextRestock = string.format("%ds", math.floor(tu))
        elseif tu < 3600 then nextRestock = string.format("%dm", math.floor(tu / 60))
        else nextRestock = string.format("%.1fh", tu / 3600) end
    else nextRestock = "In stock now" end
    return {probability = math.floor(prob), estimatedTime = estTime, confidence = #intervals >= 5 and "High" or (#intervals >= 3 and "Medium" or "Low"), trend = trend, nextRestock = nextRestock}
end

function Predictor.UpdateStockData()
    local ct = tick()
    if ct - State.LastStockUpdate < 10 then return end
    State.LastStockUpdate = ct
    if State.SeedStockPredictions or State.AutoBuySeeds then
        local sd = Utils.GetShopData("Seeds")
        for _, s in pairs(sd) do
            if not State.StockHistory.Seeds[s.Name] then State.StockHistory.Seeds[s.Name] = {} end
            table.insert(State.StockHistory.Seeds[s.Name], {InStock = s.InStock or false, Price = s.Price or 0, Timestamp = ct})
            while #State.StockHistory.Seeds[s.Name] > 20 do table.remove(State.StockHistory.Seeds[s.Name], 1) end
        end
    end
    if State.GearStockPredictions or State.AutoBuyGear then
        local gd = Utils.GetShopData("Gear")
        for _, g in pairs(gd) do
            if not State.StockHistory.Gear[g.Name] then State.StockHistory.Gear[g.Name] = {} end
            table.insert(State.StockHistory.Gear[g.Name], {InStock = g.InStock or false, Price = g.Price or 0, Timestamp = ct})
            while #State.StockHistory.Gear[g.Name] > 20 do table.remove(State.StockHistory.Gear[g.Name], 1) end
        end
    end
end

-- Weather
local WeatherSystem = {}
function WeatherSystem.FetchCurrentWeather()
    local success, result = SafeCall("GetWeatherData")
    if success and result then return result end
    local weather = "Clear"
    if Lighting:GetAttribute("Weather") then weather = Lighting:GetAttribute("Weather")
    elseif Lighting:GetAttribute("CurrentWeather") then weather = Lighting:GetAttribute("CurrentWeather") end
    for _, ef in pairs(Lighting:GetChildren()) do
        if ef:IsA("ParticleEmitter") or ef:IsA("Beam") then
            local n = ef.Name:lower()
            if n:find("rain") then weather = "Rain"
            elseif n:find("snow") then weather = "Snow"
            elseif n:find("storm") then weather = "Storm"
            elseif n:find("fog") then weather = "Fog" end
        end
    end
    return {Weather = weather, Temperature = 20, WindSpeed = 0, Humidity = 50}
end

function WeatherSystem.FetchEventData()
    local success, result = SafeCall("GetEventData")
    if success and result then return result end
    return {ActiveEvent = false}
end

function WeatherSystem.UpdatePredictions()
    if not State.EventWeatherPredictions then return end
    local cw = WeatherSystem.FetchCurrentWeather()
    local ed = WeatherSystem.FetchEventData()
    table.insert(State.WeatherHistory, {
        Weather = cw.Weather or "Unknown", Temperature = cw.Temperature or 20,
        Timestamp = tick(), EventActive = ed.ActiveEvent or false,
        EventName = ed.EventName or "None", EventWeather = ed.Weather or "Normal"
    })
    while #State.WeatherHistory > 50 do table.remove(State.WeatherHistory, 1) end
end

function WeatherSystem.GetPredictionText()
    if #State.WeatherHistory < 3 then
        return "🌤️ Weather Predictions
═══════════════════════

Gathering weather data..."
    end
    local wc, eh, tt = {}, {}, {}
    for _, e in ipairs(State.WeatherHistory) do
        wc[e.Weather] = (wc[e.Weather] or 0) + 1
        if e.EventActive then table.insert(eh, e.Timestamp) end
        table.insert(tt, e.Temperature)
    end
    local total = #State.WeatherHistory
    local preds = {}
    for w, c in pairs(wc) do table.insert(preds, {weather = w, probability = math.floor((c / total) * 100)}) end
    table.sort(preds, function(a, b) return a.probability > b.probability end)
    local text = "🌤️ Weather Predictions
═══════════════════════

"
    local cur = State.WeatherHistory[#State.WeatherHistory]
    text = text .. "📍 Current: " .. (cur.Weather or "Unknown") .. "
"
    text = text .. "🌡️ Temperature: " .. (cur.Temperature or "?") .. "°C

"
    text = text .. "📊 Forecast:
"
    for i, p in ipairs(preds) do
        if i <= 5 then
            local bar = string.rep("█", math.floor(p.probability / 10))
            local sp = string.rep("░", 10 - math.floor(p.probability / 10))
            text = text .. string.format("  %s: %s%s %d%%
", p.weather, bar, sp, p.probability)
        end
    end
    text = text .. "
🎉 Events:
"
    local ce = WeatherSystem.FetchEventData()
    if ce.ActiveEvent then
        text = text .. "✅ Active: " .. (ce.EventName or "Unknown") .. "
"
        text = text .. "🌦️ Weather: " .. (ce.Weather or "Normal") .. "
"
        if ce.Duration then text = text .. string.format("⏱️ Left: %dm %ds
", math.floor(ce.Duration / 60), ce.Duration % 60) end
    else
        text = text .. "❌ No active events
"
        if #eh > 0 then
            local iv = {}
            for i = 2, #eh do table.insert(iv, eh[i] - eh[i-1]) end
            if #iv > 0 then
                local ai = 0
                for _, v in pairs(iv) do ai = ai + v end
                ai = ai / #iv
                local le = eh[#eh]
                local ts = tick() - le
                local pb = math.min(90, math.max(10, (ts / ai) * 100))
                local tu = math.max(0, ai - ts)
                local tsr
                if tu < 60 then tsr = string.format("%ds", math.floor(tu))
                elseif tu < 3600 then tsr = string.format("%dm", math.floor(tu / 60))
                else tsr = string.format("%.1fh", tu / 3600) end
                text = text .. string.format("🔮 Next: %d%% in %s
", math.floor(pb), tsr)
            end
        end
    end
    if #tt >= 3 then
        local r, p = tt[#tt], tt[#tt-1]
        local tr = r > p and "↗ Rising" or (r < p and "↘ Falling" or "→ Stable")
        text = text .. string.format("
🌡️ Trend: %s (%+.1f°C)
", tr, r - p)
    end
    return text
end

-- Plant System
local PlantSystem = {}
function PlantSystem.PlantAtPosition(seedName, position)
    local success = pcall(function()
        local rns = {"PlantSeed","Plant","PlaceSeed","SowSeed"}
        for _, n in pairs(rns) do local ok = SafeCall(n, seedName, position) if ok then return true end end
        local bp = Player:FindFirstChild("Backpack")
        if bp then
            local st = bp:FindFirstChild(seedName)
            if not st then
                for _, t in pairs(bp:GetChildren()) do
                    if t.Name:lower():find(seedName:lower()) or seedName:lower():find(t.Name:lower()) then
                        st = t break
                    end
                end
            end
            if st and st:IsA("Tool") then
                Humanoid:EquipTool(st)
                task.wait(0.2)
                if st:FindFirstChild("RemoteEvent") then st.RemoteEvent:FireServer(position)
                else st:Activate() end
                task.wait(0.1)
                return true
            end
        end
        return false
    end)
    return success
end

function PlantSystem.AutoPlantSingle()
    if not State.AutoPlantSeed then return 0 end
    if State.SelectedSeed == "" then return 0 end
    local seeds, _ = Utils.GetInventoryItems()
    local has = false
    for _, s in pairs(seeds) do if s == State.SelectedSeed then has = true break end end
    if not has then
        for _, s in pairs(seeds) do
            if s:lower():find(State.SelectedSeed:lower()) or State.SelectedSeed:lower():find(s:lower()) then
                State.SelectedSeed = s has = true break
            end
        end
    end
    if not has then return 0 end
    local plot = Utils.GetPlot()
    if not plot then return 0 end
    local sprinklers = Utils.GetSprinklers()
    local allPos = {}
    if #sprinklers > 0 and State.UseSprinklerRadius then
        for _, sp in pairs(sprinklers) do
            local r = Utils.GetSprinklerRadius(sp)
            local pos = Utils.GetValidPlantPositions(sp:GetPivot().Position, r, plot)
            for _, p in pairs(pos) do table.insert(allPos, p) end
        end
    else
        allPos = Utils.GetValidPlantPositions(plot:GetPivot().Position, State.SprinklerRadius, plot)
    end
    table.sort(allPos, function(a, b) return (a - HumanoidRootPart.Position).Magnitude < (b - HumanoidRootPart.Position).Magnitude end)
    local planted = 0
    for _, pos in ipairs(allPos) do
        if not State.AutoPlantSeed then break end
        if planted >= State.MaxPlantsPerCycle then break end
        if (HumanoidRootPart.Position - pos).Magnitude > 15 then
            local ti = TweenInfo.new(0.3, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
            local tw = TweenService:Create(HumanoidRootPart, ti, {CFrame = CFrame.new(pos + Vector3.new(0, 3, 0))})
            tw:Play() tw.Completed:Wait()
        end
        if PlantSystem.PlantAtPosition(State.SelectedSeed, pos) then planted = planted + 1 end
        task.wait(State.PlantDelay)
    end
    return planted
end

function PlantSystem.AutoPlantAll()
    if not State.AutoPlantAllSeeds then return 0 end
    local seeds, _ = Utils.GetInventoryItems()
    if #seeds == 0 then return 0 end
    local plot = Utils.GetPlot()
    if not plot then return 0 end
    local sprinklers = Utils.GetSprinklers()
    local allPos = {}
    if #sprinklers > 0 and State.UseSprinklerRadius then
        for _, sp in pairs(sprinklers) do
            local r = Utils.GetSprinklerRadius(sp)
            local pos = Utils.GetValidPlantPositions(sp:GetPivot().Position, r, plot)
            for _, p in pairs(pos) do table.insert(allPos, p) end
        end
    else
        allPos = Utils.GetValidPlantPositions(plot:GetPivot().Position, State.SprinklerRadius, plot)
    end
    table.sort(allPos, function(a, b) return (a - HumanoidRootPart.Position).Magnitude < (b - HumanoidRootPart.Position).Magnitude end)
    local si, planted = 1, 0
    for _, pos in ipairs(allPos) do
        if not State.AutoPlantAllSeeds then break end
        if si > #seeds then break end
        if planted >= State.MaxPlantsPerCycle then break end
        if (HumanoidRootPart.Position - pos).Magnitude > 15 then
            local ti = TweenInfo.new(0.3, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
            local tw = TweenService:Create(HumanoidRootPart, ti, {CFrame = CFrame.new(pos + Vector3.new(0, 3, 0))})
            tw:Play() tw.Completed:Wait()
        end
        if PlantSystem.PlantAtPosition(seeds[si], pos) then planted = planted + 1 si = si + 1 end
        task.wait(State.PlantDelay)
    end
    return planted
end

-- Mailbox
local MailboxSystem = {}
function MailboxSystem.SendGear()
    if not State.AutoSendGear then return end
    if State.SelectedSendGear == "" or State.SendTarget == "" then return end
    local _, gear = Utils.GetInventoryItems()
    local has = false
    for _, g in pairs(gear) do if g == State.SelectedSendGear then has = true break end end
    if not has then
        for _, g in pairs(gear) do
            if g:lower():find(State.SelectedSendGear:lower()) or State.SelectedSendGear:lower():find(g:lower()) then
                State.SelectedSendGear = g has = true break
            end
        end
    end
    if not has then return end
    for i = 1, State.SendAmount do
        pcall(function()
            local rns = {"SendMail","SendGift","MailItem","SendItem"}
            for _, n in pairs(rns) do local ok = SafeCall(n, State.SendTarget, State.SelectedSendGear, 1) if ok then break end end
        end)
        task.wait(0.5)
    end
end

-- Shop
local ShopSystem = {}
function ShopSystem.AutoBuySeeds()
    if not State.AutoBuySeeds then return end
    local sd = Utils.GetShopData("Seeds")
    local cm = Utils.GetMoney()
    for _, s in pairs(sd) do
        if s.InStock and not table.find(State.IgnoredSeeds, s.Name) then
            local p = s.Price or 0
            if cm >= p and cm - p >= State.SeedBuyBudget then
                pcall(function()
                    local rns = {"BuySeed","PurchaseSeed","BuyItem"}
                    for _, n in pairs(rns) do local ok = SafeCall(n, s.Name) if ok then break end end
                end)
                cm = cm - p
                task.wait(0.3)
            end
        end
    end
end

function ShopSystem.AutoBuyGear()
    if not State.AutoBuyGear then return end
    local gd = Utils.GetShopData("Gear")
    local cm = Utils.GetMoney()
    for _, g in pairs(gd) do
        if g.InStock and not table.find(State.IgnoredGear, g.Name) then
            local p = g.Price or 0
            if cm >= p and cm - p >= State.GearBuyBudget then
                pcall(function()
                    local rns = {"BuyGear","PurchaseGear","BuyTool","BuyItem"}
                    for _, n in pairs(rns) do local ok = SafeCall(n, g.Name) if ok then break end end
                end)
                cm = cm - p
                task.wait(0.3)
            end
        end
    end
end

-- Misc
local MiscSystem = {}
function MiscSystem.ToggleFullBright(en)
    if en then
        if not State.OriginalLighting then
            State.OriginalLighting = {
                Brightness = Lighting.Brightness, ClockTime = Lighting.ClockTime,
                FogEnd = Lighting.FogEnd, FogStart = Lighting.FogStart,
                GlobalShadows = Lighting.GlobalShadows, Ambient = Lighting.Ambient,
                OutdoorAmbient = Lighting.OutdoorAmbient
            }
        end
        Lighting.Brightness = 10
        Lighting.ClockTime = 12
        Lighting.FogEnd = 100000
        Lighting.FogStart = 0
        Lighting.GlobalShadows = false
        Lighting.Ambient = Color3.fromRGB(255, 255, 255)
        Lighting.OutdoorAmbient = Color3.fromRGB(255, 255, 255)
        for _, ef in pairs(Lighting:GetChildren()) do
            if ef:IsA("Atmosphere") then ef.Density = 0 ef.Haze = 0
            elseif ef:IsA("ColorCorrectionEffect") then ef.Brightness = 0.2 ef.Contrast = 0.1
            elseif ef:IsA("BloomEffect") then ef.Intensity = 0.3
            elseif ef:IsA("BlurEffect") then ef.Size = 0 end
        end
        for _, pt in pairs(Workspace:GetDescendants()) do if pt:IsA("BasePart") then pt.CastShadow = false end end
    else
        if State.OriginalLighting then
            Lighting.Brightness = State.OriginalLighting.Brightness
            Lighting.ClockTime = State.OriginalLighting.ClockTime
            Lighting.FogEnd = State.OriginalLighting.FogEnd
            Lighting.FogStart = State.OriginalLighting.FogStart
            Lighting.GlobalShadows = State.OriginalLighting.GlobalShadows
            Lighting.Ambient = State.OriginalLighting.Ambient
            Lighting.OutdoorAmbient = State.OriginalLighting.OutdoorAmbient
        end
    end
end

function MiscSystem.ToggleInfiniteZoom(en)
    if en then
        if not State.OriginalZoom then State.OriginalZoom = Player.CameraMaxZoomDistance end
        Player.CameraMaxZoomDistance = 10000
        Player.CameraMinZoomDistance = 0.5
        RunService:BindToRenderStep("InfiniteZoom", 200, function()
            if not State.InfiniteZoomOut then RunService:UnbindFromRenderStep("InfiniteZoom") return end
            local cam = Workspace.CurrentCamera
            if UserInputService:IsKeyDown(Enum.KeyCode.LeftShift) then
                if UserInputService:IsKeyDown(Enum.KeyCode.I) then cam.FieldOfView = math.max(cam.FieldOfView - 0.5, 10)
                elseif UserInputService:IsKeyDown(Enum.KeyCode.O) then cam.FieldOfView = math.min(cam.FieldOfView + 0.5, 120)
                elseif UserInputService:IsKeyDown(Enum.KeyCode.R) then cam.FieldOfView = 70 end
            end
        end)
    else
        Player.CameraMaxZoomDistance = State.OriginalZoom or 128
        RunService:UnbindFromRenderStep("InfiniteZoom")
        Workspace.CurrentCamera.FieldOfView = 70
    end
end

function MiscSystem.ToggleNoClip(en)
    if en then
        RunService:BindToRenderStep("NoClip", 100, function()
            if not State.NoClip then RunService:UnbindFromRenderStep("NoClip") return end
            if Character then
                for _, pt in pairs(Character:GetDescendants()) do if pt:IsA("BasePart") then pt.CanCollide = false end end
            end
        end)
    else
        RunService:UnbindFromRenderStep("NoClip")
        if Character then
            for _, pt in pairs(Character:GetDescendants()) do if pt:IsA("BasePart") and pt.Name ~= "HumanoidRootPart" then pt.CanCollide = true end end
        end
    end
end

-- GUI
local Tabs = {
    Plants = Window:MakeTab({Name = "🌱 Automation Plants", Icon = "rbxassetid://4483345998", PremiumOnly = false}),
    Mailbox = Window:MakeTab({Name = "📬 Automation Mailbox", Icon = "rbxassetid://4483345998", PremiumOnly = false}),
    Seeds = Window:MakeTab({Name = "🌾 Shop Seeds", Icon = "rbxassetid://4483345998", PremiumOnly = false}),
    Gear = Window:MakeTab({Name = "⚙️ Shop Gear", Icon = "rbxassetid://4483345998", PremiumOnly = false}),
    Predictions = Window:MakeTab({Name = "🔮 Misc Predictions", Icon = "rbxassetid://4483345998", PremiumOnly = false}),
    Misc = Window:MakeTab({Name = "🛠️ Miscellaneous", Icon = "rbxassetid://4483345998", PremiumOnly = false}),
    Settings = Window:MakeTab({Name = "⚡ Settings", Icon = "rbxassetid://4483345998", PremiumOnly = false})
}

-- Plants Tab
Tabs.Plants:AddSection({Name = "Seed Selection"})
Tabs.Plants:AddDropdown({
    Name = "Select Seed to Plant", Default = "",
    Options = {"Click Refresh to Load Seeds"},
    Callback = function(Value) if Value ~= "Click Refresh to Load Seeds" then State.SelectedSeed = Value end end
})
Tabs.Plants:AddButton({
    Name = "🔄 Refresh Seed List",
    Callback = function()
        local seeds, _ = Utils.GetInventoryItems()
        OrionLib:MakeNotification({Name = "Seeds Refreshed", Content = "Found " .. #seeds .. " seed types", Image = "rbxassetid://4483345998", Time = 3})
    end
})
Tabs.Plants:AddSection({Name = "Sprinkler Settings (FIXED)"})
Tabs.Plants:AddToggle({
    Name = "Use Sprinkler Radius", Default = true,
    Callback = function(Value) State.UseSprinklerRadius = Value end
})
Tabs.Plants:AddSlider({
    Name = "Sprinkler Radius Override", Min = 1, Max = 30, Default = 5,
    Color = Color3.fromRGB(0, 255, 100), Increment = 1, ValueName = "studs",
    Callback = function(Value) State.SprinklerRadius = Value end
})
Tabs.Plants:AddLabel("✅ Sprinkler radius now works for both Auto Plant modes")
Tabs.Plants:AddSection({Name = "Planting Settings"})
Tabs.Plants:AddSlider({
    Name = "Plant Delay", Min = 0.1, Max = 3, Default = 0.3,
    Color = Color3.fromRGB(0, 255, 100), Increment = 0.1, ValueName = "seconds",
    Callback = function(Value) State.PlantDelay = Value end
})
Tabs.Plants:AddSlider({
    Name = "Max Plants Per Cycle", Min = 1, Max = 100, Default = 50,
    Color = Color3.fromRGB(0, 255, 100), Increment = 1, ValueName = "plants",
    Callback = function(Value) State.MaxPlantsPerCycle = Value end
})
Tabs.Plants:AddSection({Name = "Automation Toggles"})
Tabs.Plants:AddToggle({
    Name = "🌱 Auto Plant Selected Seed", Default = false,
    Callback = function(Value)
        State.AutoPlantSeed = Value
        if Value then
            task.spawn(function()
                while State.AutoPlantSeed and State.IsRunning do
                    PlantSystem.AutoPlantSingle()
                    task.wait(2)
                end
            end)
        end
    end
})
Tabs.Plants:AddToggle({
    Name = "🌿 Auto Plant All Seeds", Default = false,
    Callback = function(Value)
        State.AutoPlantAllSeeds = Value
        if Value then
            task.spawn(function()
                while State.AutoPlantAllSeeds and State.IsRunning do
                    PlantSystem.AutoPlantAll()
                    task.wait(2)
                end
            end)
        end
    end
})
Tabs.Plants:AddButton({
    Name = "🧹 Clear Plot (Harvest All)",
    Callback = function()
        local plot = Utils.GetPlot()
        if plot then
            local count = 0
            for _, obj in pairs(plot:GetDescendants()) do
                if obj:IsA("Model") and (obj:FindFirstChild("Seed") or obj:FindFirstChild("Plant") or obj:GetAttribute("IsPlant")) then
                    pcall(function()
                        local rns = {"HarvestPlant","Harvest","CollectPlant","PickPlant"}
                        for _, n in pairs(rns) do local ok = SafeCall(n, obj) if ok then break end end
                    end)
                    count = count + 1
                end
            end
            OrionLib:MakeNotification({Name = "Plot Cleared", Content = "Harvested " .. count .. " plants", Image = "rbxassetid://4483345998", Time = 3})
        end
    end
})

-- Mailbox Tab
Tabs.Mailbox:AddSection({Name = "Gear Selection"})
Tabs.Mailbox:AddDropdown({
    Name = "Select Send Gear", Default = "",
    Options = {"Click Refresh to Load Gear"},
    Callback = function(Value) if Value ~= "Click Refresh to Load Gear" then State.SelectedSendGear = Value end end
})
Tabs.Mailbox:AddButton({
    Name = "🔄 Refresh Gear List",
    Callback = function()
        local _, gear = Utils.GetInventoryItems()
        OrionLib:MakeNotification({Name = "Gear Refreshed", Content = "Found " .. #gear .. " gear items", Image = "rbxassetid://4483345998", Time = 3})
    end
})
Tabs.Mailbox:AddSection({Name = "Send Settings"})
Tabs.Mailbox:AddTextbox({
    Name = "Target Player Name", Default = "", TextDisappear = false,
    Callback = function(Value) State.SendTarget = Value end
})
Tabs.Mailbox:AddSlider({
    Name = "Send Amount", Min = 1, Max = 10, Default = 1,
    Color = Color3.fromRGB(255, 100, 0), Increment = 1, ValueName = "items",
    Callback = function(Value) State.SendAmount = Value end
})
Tabs.Mailbox:AddSlider({
    Name = "Send Interval", Min = 10, Max = 300, Default = 60,
    Color = Color3.fromRGB(255, 100, 0), Increment = 10, ValueName = "seconds",
    Callback = function(Value) State.SendInterval = Value end
})
Tabs.Mailbox:AddSection({Name = "Automation"})
Tabs.Mailbox:AddToggle({
    Name = "📬 Auto Send Gear", Default = false,
    Callback = function(Value)
        State.AutoSendGear = Value
        if Value then
            task.spawn(function()
                while State.AutoSendGear and State.IsRunning do
                    MailboxSystem.SendGear()
                    task.wait(State.SendInterval)
                end
            end)
        end
    end
})
Tabs.Mailbox:AddButton({
    Name = "📤 Send Once (Manual)",
    Callback = function()
        MailboxSystem.SendGear()
        OrionLib:MakeNotification({Name = "Gear Sent", Content = "Attempted to send " .. State.SelectedSendGear .. " to " .. State.SendTarget, Image = "rbxassetid://4483345998", Time = 3})
    end
})

-- Seeds Tab
Tabs.Seeds:AddSection({Name = "Ignore List"})
Tabs.Seeds:AddDropdown({
    Name = "Select Ignore Seed", Default = "", Options = {"Loading..."},
    Callback = function(Value)
        if Value ~= "" and Value ~= "Loading..." then
            if not table.find(State.IgnoredSeeds, Value) then
                table.insert(State.IgnoredSeeds, Value)
                OrionLib:MakeNotification({Name = "Seed Ignored", Content = Value .. " added to ignore list", Image = "rbxassetid://4483345998", Time = 3})
            end
        end
    end
})
Tabs.Seeds:AddButton({
    Name = "🗑️ Clear Ignore List",
    Callback = function()
        State.IgnoredSeeds = {}
        OrionLib:MakeNotification({Name = "Ignore List Cleared", Content = "All seeds removed", Image = "rbxassetid://4483345998", Time = 3})
    end
})
Tabs.Seeds:AddSection({Name = "Predictions"})
Tabs.Seeds:AddToggle({
    Name = "📊 Seed Stock Predictions", Default = false,
    Callback = function(Value) State.SeedStockPredictions = Value end
})
Tabs.Seeds:AddToggle({
    Name = "🔔 Stock Prediction Notifications", Default = false,
    Callback = function(Value) State.SeedPredictionNotifications = Value end
})
Tabs.Seeds:AddSection({Name = "Auto Buy"})
Tabs.Seeds:AddToggle({
    Name = "🛒 Auto Buy Seeds", Default = false,
    Callback = function(Value) State.AutoBuySeeds = Value end
})
Tabs.Seeds:AddSlider({
    Name = "Buy Budget Reserve", Min = 0, Max = 100000, Default = 10000,
    Color = Color3.fromRGB(0, 200, 255), Increment = 1000, ValueName = "money",
    Callback = function(Value) State.SeedBuyBudget = Value end
})
local seedPredictionParagraph = Tabs.Seeds:AddParagraph("Seed Stock Predictions", "Enable predictions to see data")

-- Gear Tab
Tabs.Gear:AddSection({Name = "Ignore List"})
Tabs.Gear:AddDropdown({
    Name = "Select Ignore Gear", Default = "", Options = {"Loading..."},
    Callback = function(Value)
        if Value ~= "" and Value ~= "Loading..." then
            if not table.find(State.IgnoredGear, Value) then
                table.insert(State.IgnoredGear, Value)
                OrionLib:MakeNotification({Name = "Gear Ignored", Content = Value .. " added to ignore list", Image = "rbxassetid://4483345998", Time = 3})
            end
        end
    end
})
Tabs.Gear:AddButton({
    Name = "🗑️ Clear Ignore List",
    Callback = function()
        State.IgnoredGear = {}
        OrionLib:MakeNotification({Name = "Ignore List Cleared", Content = "All gear removed", Image = "rbxassetid://4483345998", Time = 3})
    end
})
Tabs.Gear:AddSection({Name = "Predictions"})
Tabs.Gear:AddToggle({
    Name = "📊 Gear Stock Predictions", Default = false,
    Callback = function(Value) State.GearStockPredictions = Value end
})
Tabs.Gear:AddToggle({
    Name = "🔔 Stock Prediction Notifications", Default = false,
    Callback = function(Value) State.GearPredictionNotifications = Value end
})
Tabs.Gear:AddSection({Name = "Auto Buy"})
Tabs.Gear:AddToggle({
    Name = "🛒 Auto Buy Gear", Default = false,
    Callback = function(Value) State.AutoBuyGear = Value end
})
Tabs.Gear:AddSlider({
    Name = "Buy Budget Reserve", Min = 0, Max = 100000, Default = 10000,
    Color = Color3.fromRGB(255, 100, 200), Increment = 1000, ValueName = "money",
    Callback = function(Value) State.GearBuyBudget = Value end
})
local gearPredictionParagraph = Tabs.Gear:AddParagraph("Gear Stock Predictions", "Enable predictions to see data")

-- Predictions Tab
Tabs.Predictions:AddSection({Name = "Weather Predictions"})
Tabs.Predictions:AddToggle({
    Name = "🔮 Event Weather Predictions", Default = false,
    Callback = function(Value) State.EventWeatherPredictions = Value end
})
Tabs.Predictions:AddToggle({
    Name = "👁️ Show Weather HUD", Default = false,
    Callback = function(Value) State.ShowWeatherHUD = Value end
})
Tabs.Predictions:AddLabel("✅ Improved event weather predictions with pattern analysis")
local weatherParagraph = Tabs.Predictions:AddParagraph("Weather Predictions", "Enable predictions to see data")

-- Misc Tab
Tabs.Misc:AddSection({Name = "Visual"})
Tabs.Misc:AddToggle({
    Name = "☀️ Full Bright", Default = false,
    Callback = function(Value) State.FullBright = Value MiscSystem.ToggleFullBright(Value) end
})
Tabs.Misc:AddToggle({
    Name = "🔍 Infinite Zoom Out", Default = false,
    Callback = function(Value) State.InfiniteZoomOut = Value MiscSystem.ToggleInfiniteZoom(Value) end
})
Tabs.Misc:AddLabel("Controls: Shift + I (In) / O (Out) / R (Reset)")
Tabs.Misc:AddSection({Name = "Movement"})
Tabs.Misc:AddToggle({
    Name = "👻 No Clip", Default = false,
    Callback = function(Value) State.NoClip = Value MiscSystem.ToggleNoClip(Value) end
})
Tabs.Misc:AddSlider({
    Name = "Walk Speed", Min = 16, Max = 200, Default = 16,
    Color = Color3.fromRGB(100, 100, 255), Increment = 1, ValueName = "speed",
    Callback = function(Value) State.WalkSpeed = Value if Humanoid then Humanoid.WalkSpeed = Value end end
})
Tabs.Misc:AddSlider({
    Name = "Jump Power", Min = 50, Max = 300, Default = 50,
    Color = Color3.fromRGB(100, 100, 255), Increment = 5, ValueName = "power",
    Callback = function(Value) State.JumpPower = Value if Humanoid then Humanoid.JumpPower = Value end end
})

-- Settings Tab
Tabs.Settings:AddSection({Name = "Script Settings"})
Tabs.Settings:AddButton({
    Name = "💾 Save Configuration",
    Callback = function()
        OrionLib:SaveConfiguration()
        OrionLib:MakeNotification({Name = "Config Saved", Content = "All settings saved", Image = "rbxassetid://4483345998", Time = 3})
    end
})
Tabs.Settings:AddButton({
    Name = "🔄 Reset All Settings",
    Callback = function()
        State.AutoPlantSeed = false
        State.AutoPlantAllSeeds = false
        State.AutoSendGear = false
        State.SeedStockPredictions = false
        State.GearStockPredictions = false
        State.EventWeatherPredictions = false
        State.FullBright = false
        State.InfiniteZoomOut = false
        State.NoClip = false
        State.AutoBuySeeds = false
        State.AutoBuyGear = false
        MiscSystem.ToggleFullBright(false)
        MiscSystem.ToggleInfiniteZoom(false)
        MiscSystem.ToggleNoClip(false)
        if Humanoid then Humanoid.WalkSpeed = 16 Humanoid.JumpPower = 50 end
        OrionLib:MakeNotification({Name = "Settings Reset", Content = "All settings restored to default", Image = "rbxassetid://4483345998", Time = 3})
    end
})
Tabs.Settings:AddSection({Name = "Information"})
Tabs.Settings:AddParagraph("Script Info", "Version: 2.0.0
Game: Grow a Garden 2
Features: 15+ automation tools
Updated: June 2026")

-- Update Loops
task.spawn(function()
    while State.IsRunning do
        if State.SeedStockPredictions or State.GearStockPredictions or State.AutoBuySeeds or State.AutoBuyGear then
            Predictor.UpdateStockData()
            if State.SeedStockPredictions then
                local text = "🌾 Seed Stock Predictions
═══════════════════════════

"
                local hasData = false
                for sn, hist in pairs(State.StockHistory.Seeds) do
                    if not table.find(State.IgnoredSeeds, sn) then
                        hasData = true
                        local pred = Predictor.AnalyzeHistory(hist)
                        local le = hist[#hist]
                        local status = le and (le.InStock and "✅ In Stock" or "❌ Out of Stock") or "❓ Unknown"
                        text = text .. string.format("📦 %s
   Status: %s
   Restock: %d%% in %s
   Confidence: %s | Trend: %s
   Next: %s

", sn, status, pred.probability, pred.estimatedTime, pred.confidence, pred.trend, pred.nextRestock)
                        if State.SeedPredictionNotifications and pred.probability > 75 and le and not le.InStock then
                            OrionLib:MakeNotification({Name = "🌱 Seed Alert", Content = string.format("%s may restock soon! (%d%%)", sn, pred.probability), Image = "rbxassetid://4483345998", Time = 5})
                        end
                    end
                end
                if not hasData then text = text .. "No seed data yet.
Wait for shop updates." end
                seedPredictionParagraph:Set(text)
            end
            if State.GearStockPredictions then
                local text = "⚙️ Gear Stock Predictions
═══════════════════════════

"
                local hasData = false
                for gn, hist in pairs(State.StockHistory.Gear) do
                    if not table.find(State.IgnoredGear, gn) then
                        hasData = true
                        local pred = Predictor.AnalyzeHistory(hist)
                        local le = hist[#hist]
                        local status = le and (le.InStock and "✅ In Stock" or "❌ Out of Stock") or "❓ Unknown"
                        text = text .. string.format("🔧 %s
   Status: %s
   Restock: %d%% in %s
   Confidence: %s | Trend: %s
   Next: %s

", gn, status, pred.probability, pred.estimatedTime, pred.confidence, pred.trend, pred.nextRestock)
                        if State.GearPredictionNotifications and pred.probability > 75 and le and not le.InStock then
                            OrionLib:MakeNotification({Name = "🔧 Gear Alert", Content = string.format("%s may restock soon! (%d%%)", gn, pred.probability), Image = "rbxassetid://4483345998", Time = 5})
                        end
                    end
                end
                if not hasData then text = text .. "No gear data yet.
Wait for shop updates." end
                gearPredictionParagraph:Set(text)
            end
            if State.AutoBuySeeds then ShopSystem.AutoBuySeeds() end
            if State.AutoBuyGear then ShopSystem.AutoBuyGear() end
        end
        task.wait(15)
    end
end)

task.spawn(function()
    while State.IsRunning do
        if State.EventWeatherPredictions then
            WeatherSystem.UpdatePredictions()
            weatherParagraph:Set(WeatherSystem.GetPredictionText())
        end
        task.wait(30)
    end
end)

Player.CharacterAdded:Connect(function(nc)
    Character = nc
    Humanoid = nc:WaitForChild("Humanoid")
    HumanoidRootPart = nc:WaitForChild("HumanoidRootPart")
    if State.WalkSpeed ~= 16 then Humanoid.WalkSpeed = State.WalkSpeed end
    if State.JumpPower ~= 50 then Humanoid.JumpPower = State.JumpPower end
end)


-- ═══════════════════════════════════════════════════════════════════════
-- FLOATING WIDGET / MINIMIZE BUTTON
-- ═══════════════════════════════════════════════════════════════════════

local function CreateFloatingWidget()
    local ScreenGui = Instance.new("ScreenGui")
    ScreenGui.Name = "GAG_Widget"
    ScreenGui.Parent = game.CoreGui
    ScreenGui.ResetOnSpawn = false
    ScreenGui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

    local ButtonFrame = Instance.new("Frame")
    ButtonFrame.Name = "WidgetButton"
    ButtonFrame.Size = UDim2.new(0, 50, 0, 50)
    ButtonFrame.Position = UDim2.new(0, 20, 0, 200)
    ButtonFrame.BackgroundColor3 = Color3.fromRGB(30, 30, 30)
    ButtonFrame.BorderSizePixel = 0
    ButtonFrame.BackgroundTransparency = 0.2
    ButtonFrame.Parent = ScreenGui

    local Corner = Instance.new("UICorner")
    Corner.CornerRadius = UDim.new(1, 0)
    Corner.Parent = ButtonFrame

    local Stroke = Instance.new("UIStroke")
    Stroke.Color = Color3.fromRGB(0, 255, 100)
    Stroke.Thickness = 2
    Stroke.Parent = ButtonFrame

    local Icon = Instance.new("TextLabel")
    Icon.Name = "Icon"
    Icon.Size = UDim2.new(1, 0, 1, 0)
    Icon.BackgroundTransparency = 1
    Icon.Text = "🌱"
    Icon.TextSize = 28
    Icon.Font = Enum.Font.GothamBold
    Icon.TextColor3 = Color3.fromRGB(255, 255, 255)
    Icon.Parent = ButtonFrame

    local StatusDot = Instance.new("Frame")
    StatusDot.Name = "Status"
    StatusDot.Size = UDim2.new(0, 8, 0, 8)
    StatusDot.Position = UDim2.new(1, -10, 0, 2)
    StatusDot.BackgroundColor3 = Color3.fromRGB(0, 255, 0)
    StatusDot.BorderSizePixel = 0
    StatusDot.Parent = ButtonFrame

    local StatusCorner = Instance.new("UICorner")
    StatusCorner.CornerRadius = UDim.new(1, 0)
    StatusCorner.Parent = StatusDot

    local Tooltip = Instance.new("TextLabel")
    Tooltip.Name = "Tooltip"
    Tooltip.Size = UDim2.new(0, 180, 0, 25)
    Tooltip.Position = UDim2.new(1, 10, 0, 0)
    Tooltip.BackgroundColor3 = Color3.fromRGB(40, 40, 40)
    Tooltip.TextColor3 = Color3.fromRGB(255, 255, 255)
    Tooltip.Text = "GAG Hub - Click to Toggle"
    Tooltip.TextSize = 12
    Tooltip.Font = Enum.Font.Gotham
    Tooltip.Visible = false
    Tooltip.Parent = ButtonFrame

    local TooltipCorner = Instance.new("UICorner")
    TooltipCorner.CornerRadius = UDim.new(0, 4)
    TooltipCorner.Parent = Tooltip

    -- Dragging
    local dragging = false
    local dragStart = nil
    local startPos = nil

    ButtonFrame.InputBegan:Connect(function(input)
        if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
            dragging = true
            dragStart = input.Position
            startPos = ButtonFrame.Position
            input.Changed:Connect(function()
                if input.UserInputState == Enum.UserInputState.End then dragging = false end
            end)
        end
    end)

    ButtonFrame.InputChanged:Connect(function(input)
        if dragging and (input.UserInputType == Enum.UserInputType.MouseMovement or input.UserInputType == Enum.UserInputType.Touch) then
            local delta = input.Position - dragStart
            ButtonFrame.Position = UDim2.new(startPos.X.Scale, startPos.X.Offset + delta.X, startPos.Y.Scale, startPos.Y.Offset + delta.Y)
        end
    end)

    -- Hover
    ButtonFrame.MouseEnter:Connect(function()
        Tooltip.Visible = true
        TweenService:Create(ButtonFrame, TweenInfo.new(0.2), {BackgroundTransparency = 0}):Play()
        TweenService:Create(Stroke, TweenInfo.new(0.2), {Thickness = 3}):Play()
    end)

    ButtonFrame.MouseLeave:Connect(function()
        Tooltip.Visible = false
        TweenService:Create(ButtonFrame, TweenInfo.new(0.2), {BackgroundTransparency = 0.2}):Play()
        TweenService:Create(Stroke, TweenInfo.new(0.2), {Thickness = 2}):Play()
    end)

    -- Toggle UI
    local uiVisible = true
    ButtonFrame.InputEnded:Connect(function(input)
        if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
            if not dragging then
                uiVisible = not uiVisible
                for _, gui in pairs(game.CoreGui:GetChildren()) do
                    if gui.Name:find("Orion") then
                        for _, frame in pairs(gui:GetDescendants()) do
                            if frame:IsA("Frame") and frame.Name == "Main" then
                                frame.Visible = uiVisible
                            end
                        end
                    end
                end
                Icon.Text = uiVisible and "🌱" or "🌿"
                StatusDot.BackgroundColor3 = uiVisible and Color3.fromRGB(0, 255, 0) or Color3.fromRGB(255, 0, 0)
                Tooltip.Text = uiVisible and "GAG Hub - Click to Hide" or "GAG Hub - Click to Show"
            end
        end
    end)

    -- Status update
    task.spawn(function()
        while State.IsRunning do
            local anyActive = State.AutoPlantSeed or State.AutoPlantAllSeeds or State.AutoSendGear 
                or State.AutoBuySeeds or State.AutoBuyGear or State.SeedStockPredictions 
                or State.GearStockPredictions or State.EventWeatherPredictions
            if anyActive then StatusDot.BackgroundColor3 = Color3.fromRGB(0, 255, 255)
            else StatusDot.BackgroundColor3 = uiVisible and Color3.fromRGB(0, 255, 0) or Color3.fromRGB(255, 0, 0) end
            task.wait(1)
        end
    end)

    return ScreenGui
end

OrionLib:Init()
OrionLib:MakeNotification({Name = "🌱 Grow a Garden 2", Content = "Premium Hub v2.0 Loaded!", Image = "rbxassetid://4483345998", Time = 5})

task.spawn(function()
    task.wait(2)
    Predictor.UpdateStockData()
    WeatherSystem.UpdatePredictions()
    OrionLib:MakeNotification({Name = "📊 Data Collection", Content = "Initial data collected. Predictions active.", Image = "rbxassetid://4483345998", Time = 3})
end)

print("[GAG2 Hub v2.0] Script initialized successfully")
Gear() end
        end
        task.wait(15)
    end
end)

-- Weather prediction loop
task.spawn(function()
    while State.IsRunning do
        if State.EventWeatherPredictions then
            WeatherSystem.UpdatePredictions()
            weatherParagraph:Set(WeatherSystem.GetPredictionText())
        end
        task.wait(30)
    end
end)

-- Character refresh handler
Player.CharacterAdded:Connect(function(nc)
    Character = nc
    Humanoid = nc:WaitForChild("Humanoid")
    HumanoidRootPart = nc:WaitForChild("HumanoidRootPart")
    if State.WalkSpeed ~= 16 then Humanoid.WalkSpeed = State.WalkSpeed end
    if State.JumpPower ~= 50 then Humanoid.JumpPower = State.JumpPower end
end)

-- ═══════════════════════════════════════════════════════════════════════
-- INITIALIZATION
-- ═══════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════
-- FLOATING WIDGET / MINIMIZE BUTTON
-- ═══════════════════════════════════════════════════════════════════════

local function CreateFloatingWidget()
    local ScreenGui = Instance.new("ScreenGui")
    ScreenGui.Name = "GAG_Widget"
    ScreenGui.Parent = game.CoreGui
    ScreenGui.ResetOnSpawn = false
    ScreenGui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

    local ButtonFrame = Instance.new("Frame")
    ButtonFrame.Name = "WidgetButton"
    ButtonFrame.Size = UDim2.new(0, 50, 0, 50)
    ButtonFrame.Position = UDim2.new(0, 20, 0, 200)
    ButtonFrame.BackgroundColor3 = Color3.fromRGB(30, 30, 30)
    ButtonFrame.BorderSizePixel = 0
    ButtonFrame.BackgroundTransparency = 0.2
    ButtonFrame.Parent = ScreenGui

    local Corner = Instance.new("UICorner")
    Corner.CornerRadius = UDim.new(1, 0)
    Corner.Parent = ButtonFrame

    local Stroke = Instance.new("UIStroke")
    Stroke.Color = Color3.fromRGB(0, 255, 100)
    Stroke.Thickness = 2
    Stroke.Parent = ButtonFrame

    local Icon = Instance.new("TextLabel")
    Icon.Name = "Icon"
    Icon.Size = UDim2.new(1, 0, 1, 0)
    Icon.BackgroundTransparency = 1
    Icon.Text = "🌱"
    Icon.TextSize = 28
    Icon.Font = Enum.Font.GothamBold
    Icon.TextColor3 = Color3.fromRGB(255, 255, 255)
    Icon.Parent = ButtonFrame

    local StatusDot = Instance.new("Frame")
    StatusDot.Name = "Status"
    StatusDot.Size = UDim2.new(0, 8, 0, 8)
    StatusDot.Position = UDim2.new(1, -10, 0, 2)
    StatusDot.BackgroundColor3 = Color3.fromRGB(0, 255, 0)
    StatusDot.BorderSizePixel = 0
    StatusDot.Parent = ButtonFrame

    local StatusCorner = Instance.new("UICorner")
    StatusCorner.CornerRadius = UDim.new(1, 0)
    StatusCorner.Parent = StatusDot

    local Tooltip = Instance.new("TextLabel")
    Tooltip.Name = "Tooltip"
    Tooltip.Size = UDim2.new(0, 180, 0, 25)
    Tooltip.Position = UDim2.new(1, 10, 0, 0)
    Tooltip.BackgroundColor3 = Color3.fromRGB(40, 40, 40)
    Tooltip.TextColor3 = Color3.fromRGB(255, 255, 255)
    Tooltip.Text = "GAG Hub - Click to Toggle"
    Tooltip.TextSize = 12
    Tooltip.Font = Enum.Font.Gotham
    Tooltip.Visible = false
    Tooltip.Parent = ButtonFrame

    local TooltipCorner = Instance.new("UICorner")
    TooltipCorner.CornerRadius = UDim.new(0, 4)
    TooltipCorner.Parent = Tooltip

    -- Dragging
    local dragging = false
    local dragStart = nil
    local startPos = nil

    ButtonFrame.InputBegan:Connect(function(input)
        if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
            dragging = true
            dragStart = input.Position
            startPos = ButtonFrame.Position
            input.Changed:Connect(function()
                if input.UserInputState == Enum.UserInputState.End then dragging = false end
            end)
        end
    end)

    ButtonFrame.InputChanged:Connect(function(input)
        if dragging and (input.UserInputType == Enum.UserInputType.MouseMovement or input.UserInputType == Enum.UserInputType.Touch) then
            local delta = input.Position - dragStart
            ButtonFrame.Position = UDim2.new(startPos.X.Scale, startPos.X.Offset + delta.X, startPos.Y.Scale, startPos.Y.Offset + delta.Y)
        end
    end)

    -- Hover
    ButtonFrame.MouseEnter:Connect(function()
        Tooltip.Visible = true
        TweenService:Create(ButtonFrame, TweenInfo.new(0.2), {BackgroundTransparency = 0}):Play()
        TweenService:Create(Stroke, TweenInfo.new(0.2), {Thickness = 3}):Play()
    end)

    ButtonFrame.MouseLeave:Connect(function()
        Tooltip.Visible = false
        TweenService:Create(ButtonFrame, TweenInfo.new(0.2), {BackgroundTransparency = 0.2}):Play()
        TweenService:Create(Stroke, TweenInfo.new(0.2), {Thickness = 2}):Play()
    end)

    -- Toggle UI
    local uiVisible = true
    ButtonFrame.InputEnded:Connect(function(input)
        if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
            if not dragging then
                uiVisible = not uiVisible
                for _, gui in pairs(game.CoreGui:GetChildren()) do
                    if gui.Name:find("Orion") then
                        for _, frame in pairs(gui:GetDescendants()) do
                            if frame:IsA("Frame") and frame.Name == "Main" then
                                frame.Visible = uiVisible
                            end
                        end
                    end
                end
                Icon.Text = uiVisible and "🌱" or "🌿"
                StatusDot.BackgroundColor3 = uiVisible and Color3.fromRGB(0, 255, 0) or Color3.fromRGB(255, 0, 0)
                Tooltip.Text = uiVisible and "GAG Hub - Click to Hide" or "GAG Hub - Click to Show"
            end
        end
    end)

    -- Status update
    task.spawn(function()
        while State.IsRunning do
            local anyActive = State.AutoPlantSeed or State.AutoPlantAllSeeds or State.AutoSendGear 
                or State.AutoBuySeeds or State.AutoBuyGear or State.SeedStockPredictions 
                or State.GearStockPredictions or State.EventWeatherPredictions
            if anyActive then StatusDot.BackgroundColor3 = Color3.fromRGB(0, 255, 255)
            else StatusDot.BackgroundColor3 = uiVisible and Color3.fromRGB(0, 255, 0) or Color3.fromRGB(255, 0, 0) end
            task.wait(1)
        end
    end)

    return ScreenGui
end

OrionLib:Init()

local Widget = CreateFloatingWidget()

OrionLib:MakeNotification({
    Name = "🌱 GAG Universal Hub",
    Content = "v2.1 Loaded! Detected: " .. GameVersion,
    Image = "rbxassetid://4483345998",
    Time = 5
})

task.spawn(function()
    task.wait(2)
    Predictor.UpdateStockData()
    WeatherSystem.UpdatePredictions()
    OrionLib:MakeNotification({
        Name = "📊 Data Collection",
        Content = "Initial data collected. Predictions active.",
        Image = "rbxassetid://4483345998",
        Time = 3
    })
end)

print("[GAG Universal Hub v2.1] Script initialized. Game: " .. GameVersion)
